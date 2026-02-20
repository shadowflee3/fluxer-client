const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  clipboard,
  Notification,
  dialog,
} = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const os = require('os')
const crypto = require('crypto')

const APP_URL = 'https://chat.shadowflee.com'
const APP_NAME = 'Fluxer'
const ICON_PATH = path.join(__dirname, 'assets', `icon.${process.platform === 'win32' ? 'ico' : 'png'}`)

// Prevent Electron's Chromium from picking up system proxy settings which can
// cause ERR_NAME_NOT_RESOLVED even when the browser resolves the domain fine.
app.commandLine.appendSwitch('no-proxy-server')

// WebRTC: expose real local IPs in ICE candidates instead of obfuscated mDNS
// hostnames. Without this, LAN-based peer connections (e.g. screen sharing)
// fail because .local mDNS hostnames can't be resolved between peers.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

// Allow incoming WebRTC media streams (screen shares, video) to autoplay
// without requiring a user gesture — same as browser default for trusted sites.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow = null
let tray = null
let isQuitting = false

// ── Global key hook (PTT) ─────────────────────────────────────────────────────
let uIOhook = null
let UiohookKey = null
let hookStarted = false
const registeredKeybinds = new Map()

// ── Screen sharing ────────────────────────────────────────────────────────────
// Unified Map keyed by requestId so callback and timeout are always in sync
const pendingDisplayRequests = new Map() // requestId → { callback, timeout }
const cachedSources = new Map()

// ── Global shortcuts ──────────────────────────────────────────────────────────
const registeredShortcuts = new Map()

// ── Notifications ─────────────────────────────────────────────────────────────
const activeNotifications = new Map() // id → { notification, url, autoCleanTimeout }

// ── App badge debounce ─────────────────────────────────────────────────────────
// Module-level so before-quit can cancel a pending write during shutdown.
let _badgeDebounceTimer = null

// ── Custom notification sound ─────────────────────────────────────────────────
let _notifSoundPath = null        // absolute path to user-chosen audio file, or null
let _pickingSoundInProgress = false // guard against concurrent file-picker dialogs

// ── Configurable server URL ───────────────────────────────────────────────────
let appUrl = APP_URL // Overridden at startup from saved config
let configWindow = null

function loadServerUrl() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    if (typeof cfg.serverUrl === 'string') {
      const p = new URL(cfg.serverUrl)
      if (['http:', 'https:'].includes(p.protocol)) return cfg.serverUrl
    }
  } catch {}
  return null // null = first run, no server configured yet
}

// ── Centralised config persistence ───────────────────────────────────────────
// A single read-modify-write prevents concurrent saves (e.g. saveServerUrl and
// saveTheme called in the same tick) from clobbering each other's keys.
function saveConfig(patch) {
  const cfgPath = path.join(app.getPath('userData'), 'config.json')
  const tmp = cfgPath + '.tmp'
  try {
    let cfg = {}
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch {}
    Object.assign(cfg, patch)
    // Spread into a fresh object so any accidental toJSON property on cfg or patch
    // cannot hijack JSON.stringify output.
    fs.writeFileSync(tmp, JSON.stringify({ ...cfg }))
    fs.renameSync(tmp, cfgPath)
  } catch {
    // Remove partial temp file so it doesn't accumulate on disk
    try { fs.unlinkSync(tmp) } catch {}
  }
}

function saveServerUrl(url) { saveConfig({ serverUrl: url }) }

// ── Theme (dark / light / system) ────────────────────────────────────────────
let currentTheme = 'dark' // default to dark

function loadTheme() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    if (['dark', 'light', 'system'].includes(cfg.theme)) return cfg.theme
  } catch {}
  return 'dark'
}

function saveTheme(theme) { saveConfig({ theme }) }

function applyTheme(theme) {
  currentTheme = theme
  nativeTheme.themeSource = theme
  saveTheme(theme)
  rebuildTrayMenu()
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ── Notification sound helpers ────────────────────────────────────────────────

// Validate audio by magic bytes, not file extension (extension can be spoofed).
function validateAudioMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  // WAV: "RIFF"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'audio/wav'
  // OGG: "OggS"
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return 'audio/ogg'
  // MP3: ID3 tag header
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'
  // MP3: MPEG sync frame (FF E* or FF F*)
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'audio/mpeg'
  return null
}

function loadNotificationSound() {
  _notifSoundPath = null
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    if (typeof cfg.notificationSound === 'string' && cfg.notificationSound) {
      const st = fs.statSync(cfg.notificationSound)
      if (st.isFile()) _notifSoundPath = cfg.notificationSound
    }
  } catch {}
}

// Read the custom sound file and return a base64 data URI.
// Returns null if no custom sound is set or the file is invalid/too large.
function getNotificationSoundDataUri() {
  if (!_notifSoundPath) return null
  try {
    const st = fs.statSync(_notifSoundPath)
    if (!st.isFile() || st.size > 5 * 1024 * 1024) { _notifSoundPath = null; return null }
    const buf = fs.readFileSync(_notifSoundPath)
    const mime = validateAudioMime(buf)
    if (!mime) { _notifSoundPath = null; return null }
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch { _notifSoundPath = null; return null }
}

// Send the custom sound to the renderer to play via HTML5 Audio.
function playNotificationSound() {
  const dataUri = getNotificationSoundDataUri()
  if (!dataUri || !isWindowReady()) return
  try { mainWindow.webContents.send('play-notification-sound', dataUri) } catch {}
}

// Open a file picker and, if the user picks a valid audio file, save it.
async function pickNotificationSound(parentWin) {
  if (_pickingSoundInProgress) return { success: false, error: 'Picker already open' }
  _pickingSoundInProgress = true
  const win = parentWin && !parentWin.isDestroyed() ? parentWin : (isWindowReady() ? mainWindow : null)
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Notification Sound',
      filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { success: false }
    const filePath = result.filePaths[0]
    const buf = fs.readFileSync(filePath)
    if (buf.length > 5 * 1024 * 1024) return { success: false, error: 'File too large (max 5 MB)' }
    if (!validateAudioMime(buf)) return { success: false, error: 'Unsupported format — use MP3, WAV, or OGG' }
    _notifSoundPath = filePath
    saveConfig({ notificationSound: filePath })
    rebuildTrayMenu()
    return { success: true, name: path.basename(filePath) }
  } catch (err) { return { success: false, error: err.message } }
  finally { _pickingSoundInProgress = false }
}

function clearNotificationSound() {
  _notifSoundPath = null
  saveConfig({ notificationSound: null })
  rebuildTrayMenu()
}

function escHtml(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isWindowReady() {
  return mainWindow && !mainWindow.isDestroyed()
}

// ─────────────────────────────────────────────────────────────────────────────
// Single instance lock
// ─────────────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (isWindowReady()) {
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Global key hook helpers
// ─────────────────────────────────────────────────────────────────────────────
// Built once when first needed so we don't rebuild the map on every keypress
let _keycodeMap = null
function getKeycodeMap() {
  if (_keycodeMap) return _keycodeMap
  _keycodeMap = {
    [UiohookKey.Escape]: 'Escape',
    [UiohookKey.F1]: 'F1', [UiohookKey.F2]: 'F2', [UiohookKey.F3]: 'F3',
    [UiohookKey.F4]: 'F4', [UiohookKey.F5]: 'F5', [UiohookKey.F6]: 'F6',
    [UiohookKey.F7]: 'F7', [UiohookKey.F8]: 'F8', [UiohookKey.F9]: 'F9',
    [UiohookKey.F10]: 'F10', [UiohookKey.F11]: 'F11', [UiohookKey.F12]: 'F12',
    [UiohookKey.Backquote]: 'Backquote',
    [UiohookKey['1']]: '1', [UiohookKey['2']]: '2', [UiohookKey['3']]: '3',
    [UiohookKey['4']]: '4', [UiohookKey['5']]: '5', [UiohookKey['6']]: '6',
    [UiohookKey['7']]: '7', [UiohookKey['8']]: '8', [UiohookKey['9']]: '9',
    [UiohookKey['0']]: '0',
    [UiohookKey.Minus]: 'Minus', [UiohookKey.Equal]: 'Equal',
    [UiohookKey.Backspace]: 'Backspace', [UiohookKey.Tab]: 'Tab',
    [UiohookKey.Q]: 'Q', [UiohookKey.W]: 'W', [UiohookKey.E]: 'E',
    [UiohookKey.R]: 'R', [UiohookKey.T]: 'T', [UiohookKey.Y]: 'Y',
    [UiohookKey.U]: 'U', [UiohookKey.I]: 'I', [UiohookKey.O]: 'O',
    [UiohookKey.P]: 'P', [UiohookKey.BracketLeft]: 'BracketLeft',
    [UiohookKey.BracketRight]: 'BracketRight', [UiohookKey.Backslash]: 'Backslash',
    [UiohookKey.CapsLock]: 'CapsLock',
    [UiohookKey.A]: 'A', [UiohookKey.S]: 'S', [UiohookKey.D]: 'D',
    [UiohookKey.F]: 'F', [UiohookKey.G]: 'G', [UiohookKey.H]: 'H',
    [UiohookKey.J]: 'J', [UiohookKey.K]: 'K', [UiohookKey.L]: 'L',
    [UiohookKey.Semicolon]: 'Semicolon', [UiohookKey.Quote]: 'Quote',
    [UiohookKey.Enter]: 'Enter',
    [UiohookKey.Shift]: 'ShiftLeft', [UiohookKey.ShiftRight]: 'ShiftRight',
    [UiohookKey.Z]: 'Z', [UiohookKey.X]: 'X', [UiohookKey.C]: 'C',
    [UiohookKey.V]: 'V', [UiohookKey.B]: 'B', [UiohookKey.N]: 'N',
    [UiohookKey.M]: 'M', [UiohookKey.Comma]: 'Comma',
    [UiohookKey.Period]: 'Period', [UiohookKey.Slash]: 'Slash',
    [UiohookKey.Ctrl]: 'ControlLeft', [UiohookKey.CtrlRight]: 'ControlRight',
    [UiohookKey.Meta]: 'MetaLeft', [UiohookKey.MetaRight]: 'MetaRight',
    [UiohookKey.Alt]: 'AltLeft', [UiohookKey.AltRight]: 'AltRight',
    [UiohookKey.Space]: 'Space',
    [UiohookKey.ArrowLeft]: 'ArrowLeft', [UiohookKey.ArrowUp]: 'ArrowUp',
    [UiohookKey.ArrowRight]: 'ArrowRight', [UiohookKey.ArrowDown]: 'ArrowDown',
    [UiohookKey.Insert]: 'Insert', [UiohookKey.Delete]: 'Delete',
    [UiohookKey.Home]: 'Home', [UiohookKey.End]: 'End',
    [UiohookKey.PageUp]: 'PageUp', [UiohookKey.PageDown]: 'PageDown',
  }
  return _keycodeMap
}

function keycodeToKeyName(keycode) {
  if (!UiohookKey) return `Key${keycode}`
  return getKeycodeMap()[keycode] ?? `Key${keycode}`
}

function handleKeyEvent(event, type) {
  // Guard: don't fire if hook has been stopped or window is gone
  if (!hookStarted || !isWindowReady()) return
  const { keycode } = event
  const keyName = keycodeToKeyName(keycode)

  mainWindow.webContents.send('global-key-event', {
    type, keycode, keyName,
    altKey: event.altKey, ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey, metaKey: event.metaKey,
  })

  for (const [id, kb] of registeredKeybinds) {
    if (kb.keycode === keycode) {
      const modMatch =
        kb.modifiers.ctrl === event.ctrlKey &&
        kb.modifiers.alt === event.altKey &&
        kb.modifiers.shift === event.shiftKey &&
        kb.modifiers.meta === event.metaKey
      if (modMatch) {
        mainWindow.webContents.send('global-keybind-triggered', { id, type })
      }
    }
  }
}

function handleMouseEvent(event, type) {
  if (!hookStarted || !isWindowReady()) return
  mainWindow.webContents.send('global-mouse-event', { type, button: event.button })
  for (const [id, kb] of registeredKeybinds) {
    if (kb.mouseButton === event.button) {
      mainWindow.webContents.send('global-keybind-triggered', {
        id,
        type: type === 'mousedown' ? 'keydown' : 'keyup',
      })
    }
  }
}

let _startHookPromise = null
async function startHook() {
  if (hookStarted) return true
  // Prevent concurrent start calls from double-registering listeners
  if (_startHookPromise) return _startHookPromise
  _startHookPromise = (async () => {
    try {
    const mod = require('uiohook-napi')
    uIOhook = mod.uIOhook
    UiohookKey = mod.UiohookKey
    uIOhook.removeAllListeners()
    uIOhook.on('keydown', e => handleKeyEvent(e, 'keydown'))
    uIOhook.on('keyup', e => handleKeyEvent(e, 'keyup'))
    uIOhook.on('mousedown', e => handleMouseEvent(e, 'mousedown'))
    uIOhook.on('mouseup', e => handleMouseEvent(e, 'mouseup'))
    uIOhook.on('error', err => {
      console.error('[KeyHook] Runtime error:', err)
      // Mirror stopHook cleanup so stale listeners don't fire on a future restart
      hookStarted = false
      try { uIOhook.removeAllListeners() } catch {}
      try { uIOhook.stop() } catch {}
    })
    uIOhook.start()
    hookStarted = true // Only set after successful start so is-running reports accurately
    console.log('[KeyHook] Started')
    return true
    } catch (err) {
      console.error('[KeyHook] Failed to start:', err)
      // Clean up partial state so a retry is safe
      if (uIOhook) {
        try { uIOhook.removeAllListeners() } catch {}
        try { uIOhook.stop() } catch {}
      }
      hookStarted = false
      return false
    } finally {
      _startHookPromise = null
    }
  })()
  return _startHookPromise
}

function stopHook() {
  if (!hookStarted || !uIOhook) return
  // Set flag first so handleKeyEvent/handleMouseEvent guards take effect immediately,
  // before any native-buffered events queued after stop() can be delivered.
  hookStarted = false
  try { uIOhook.removeAllListeners() } catch {}
  try { uIOhook.stop() } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// File download helper
// ─────────────────────────────────────────────────────────────────────────────
function downloadToFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) { reject(new Error('Too many redirects')); return }
    // Validate protocol here too — redirect Location headers are untrusted
    let parsedUrl
    try { parsedUrl = new URL(url) } catch { reject(new Error('Invalid URL')); return }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      reject(new Error('Invalid URL protocol')); return
    }
    const protocol = parsedUrl.protocol === 'https:' ? https : http
    const file = fs.createWriteStream(destPath)
    let settled = false
    const settle = (fn, val) => {
      if (settled) return
      settled = true
      // Wait for FD to fully close before resolving so callers can safely
      // move/open the file (avoids EBUSY on Windows)
      file.close(() => fn(val))
    }
    const cleanup = () => fs.unlink(destPath, () => {})

    const req = protocol.get(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const location = response.headers.location
        if (!location) { cleanup(); settle(reject, new Error('Redirect without Location')); return }
        // Remove the file error listener first — no window where the listener
        // is still attached but cleanup() could race the recursive open.
        file.removeAllListeners('error')
        // Mark settled before destroying so the req.on('error') handler below
        // cannot spuriously reject if req emits an error after destruction.
        settled = true
        // Drain the redirect response body to release the socket promptly
        try { response.resume() } catch {}
        try { req.destroy() } catch {}
        file.close(closeErr => {
          if (closeErr) { cleanup(); reject(closeErr); return }
          downloadToFile(location, destPath, redirects + 1).then(resolve).catch(reject)
        })
        return
      }
      if (response.statusCode !== 200) {
        cleanup(); settle(reject, new Error(`HTTP ${response.statusCode}`)); return
      }
      // Manually write chunks (no pipe) so the 512 MB cap is enforced before
      // any data reaches disk — pipe buffers make post-hoc unpipe unreliable.
      let bytesReceived = 0
      const MAX_BYTES = 512 * 1024 * 1024
      response.on('data', chunk => {
        if (settled) return
        bytesReceived += chunk.length
        if (bytesReceived > MAX_BYTES) {
          cleanup()
          settle(reject, new Error('Response too large (>512 MB)'))
          try { response.destroy() } catch {}
          return
        }
        // Handle backpressure — pause the network stream when the disk write buffer is full
        const ok = file.write(chunk)
        if (!ok) {
          response.pause()
          file.once('drain', () => { if (!settled) response.resume() })
        }
      })
      response.on('end', () => { if (!settled) file.end() })
      response.on('error', err => { if (settled) return; cleanup(); settle(reject, err) })
      file.on('finish', () => settle(resolve))
    })
    // 30-second idle timeout — prevents hanging forever if the server accepts
    // the TCP connection but never sends bytes.
    req.setTimeout(30_000, () => req.destroy(new Error('Request timed out')))
    req.on('error', err => { if (settled) return; cleanup(); settle(reject, err) })
    file.on('error', err => { if (settled) return; cleanup(); settle(reject, err) })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  // Desktop info
  ipcMain.handle('get-desktop-info', () => ({
    version: app.getVersion(),
    channel: 'stable',
    arch: process.arch,
    hardwareArch: os.arch(),
    runningUnderRosetta: false,
    os: process.platform,
    osVersion: os.release(),
    systemVersion: process.getSystemVersion?.() ?? os.release(),
  }))

  // Window controls
  ipcMain.on('window-minimize', () => { try { if (isWindowReady()) mainWindow.minimize() } catch {} })
  ipcMain.on('window-maximize', () => {
    try {
      if (!isWindowReady()) return
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    } catch {}
  })
  ipcMain.on('window-close', () => { try { if (!isQuitting && isWindowReady()) mainWindow.hide() } catch {} })
  ipcMain.handle('window-is-maximized', () => {
    try { return mainWindow?.isMaximized() ?? false } catch { return false }
  })

  // External links
  ipcMain.handle('open-external', async (_e, url) => {
    try {
      const parsed = new URL(url)
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(url)
      }
    } catch {}
  })

  // Clipboard
  ipcMain.handle('clipboard-write-text', (_e, text) => clipboard.writeText(String(text ?? '').slice(0, 1_000_000)))
  ipcMain.handle('clipboard-read-text', () => { try { return clipboard.readText() } catch { return '' } })

  // Deep links
  ipcMain.handle('get-initial-deep-link', () => null)

  // ── Screen sharing ──────────────────────────────────────────────────────────
  ipcMain.handle('get-desktop-sources', async (_e, types) => {
    try {
      const VALID_TYPES = ['screen', 'window']
      const safeTypes = Array.isArray(types)
        ? types.filter(t => VALID_TYPES.includes(t))
        : []
      const sources = await desktopCapturer.getSources({
        types: safeTypes.length ? safeTypes : VALID_TYPES,
        thumbnailSize: { width: 320, height: 180 },
      })
      cachedSources.clear()
      for (const s of sources) cachedSources.set(s.id, s)
      return sources.map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        display_id: s.display_id ?? '',
      }))
    } catch (err) {
      console.error('[DesktopCapturer] getSources failed:', err)
      return []
    }
  })

  ipcMain.on('select-display-media-source', (_e, requestId, sourceId, withAudio) => {
    try {
      if (typeof requestId !== 'string') return
      const req = pendingDisplayRequests.get(requestId)
      if (!req) {
        // Unknown requestId — clear stale cache to avoid memory leak
        cachedSources.clear()
        return
      }
      clearTimeout(req.timeout)
      pendingDisplayRequests.delete(requestId)

      if (!sourceId) {
        cachedSources.clear()
        req.callback({ video: null })
        return
      }

      const source = cachedSources.get(sourceId)
      cachedSources.clear()
      req.callback(source
        ? { video: source, ...(withAudio && { audio: 'loopback' }) }
        : { video: null }
      )
    } catch (err) {
      console.error('[DisplayMedia] select handler error:', err)
    }
  })

  // ── Global shortcuts ────────────────────────────────────────────────────────
  ipcMain.handle('register-global-shortcut', (_e, { accelerator, id }) => {
    if (!accelerator || !id) return false
    if (typeof accelerator !== 'string' || accelerator.length > 64) return false
    if (typeof id !== 'string' || id.length > 128) return false
    if (registeredShortcuts.size >= 32 && !registeredShortcuts.has(accelerator)) return false
    try {
      if (registeredShortcuts.has(accelerator)) globalShortcut.unregister(accelerator)
      const ok = globalShortcut.register(accelerator, () => {
        if (isWindowReady()) mainWindow.webContents.send('global-shortcut-triggered', id)
      })
      if (ok) registeredShortcuts.set(accelerator, id)
      return ok
    } catch { return false }
  })
  ipcMain.handle('unregister-global-shortcut', (_e, accelerator) => {
    try {
      if (registeredShortcuts.has(accelerator)) {
        globalShortcut.unregister(accelerator)
        registeredShortcuts.delete(accelerator)
        return true
      }
      return false
    } catch { return false }
  })
  ipcMain.handle('unregister-all-global-shortcuts', () => {
    try { globalShortcut.unregisterAll(); registeredShortcuts.clear(); return true } catch { return false }
  })

  // ── Autostart ───────────────────────────────────────────────────────────────
  const autostartFlagPath = path.join(app.getPath('userData'), 'autostart-initialized')
  ipcMain.handle('autostart-enable', () => {
    try { app.setLoginItemSettings({ openAtLogin: true, name: APP_NAME }) } catch {}
  })
  ipcMain.handle('autostart-disable', () => {
    try { app.setLoginItemSettings({ openAtLogin: false, name: APP_NAME }) } catch {}
  })
  ipcMain.handle('autostart-is-enabled', () => {
    try { return app.getLoginItemSettings().openAtLogin } catch { return false }
  })
  ipcMain.handle('autostart-is-initialized', () => {
    try { return fs.existsSync(autostartFlagPath) } catch { return false }
  })
  ipcMain.handle('autostart-mark-initialized', () => {
    try { fs.writeFileSync(autostartFlagPath, '1'); return true } catch (err) {
      console.error('[Autostart] Failed to write flag:', err)
      return false
    }
  })

  // ── Media / accessibility (always granted on Windows) ──────────────────────
  ipcMain.handle('check-media-access', () => 'granted')
  ipcMain.handle('request-media-access', () => true)
  ipcMain.handle('open-media-access-settings', () => {})
  ipcMain.handle('check-accessibility', () => true)
  ipcMain.handle('open-accessibility-settings', () => {})
  ipcMain.handle('open-input-monitoring-settings', () => {})

  // ── App badge ───────────────────────────────────────────────────────────────
  // Debounce rapid-fire badge updates (e.g. per-message increments) to avoid
  // flooding the OS taskbar overlay with high-frequency writes.
  ipcMain.on('set-badge-count', (_e, count) => {
    clearTimeout(_badgeDebounceTimer)
    _badgeDebounceTimer = setTimeout(() => {
      try { const n = Math.max(0, Math.trunc(Number(count ?? 0))); app.badgeCount = isFinite(n) ? n : 0 } catch {}
    }, 50)
  })
  ipcMain.handle('get-badge-count', () => { try { return app.badgeCount ?? 0 } catch { return 0 } })
  ipcMain.handle('bounce-dock', () => -1) // async now — no more sendSync
  ipcMain.on('cancel-bounce-dock', () => {})

  // ── Zoom ─────────────────────────────────────────────────────────────────────
  const zoomFilePath = path.join(app.getPath('userData'), 'zoom.json')
  ipcMain.on('set-zoom-factor', (event, factor) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const clamped = Math.min(3.0, Math.max(0.5, Number(factor)))
      if (win && !win.isDestroyed() && isFinite(clamped)) {
        win.webContents.setZoomFactor(clamped)
        // Only persist zoom from the main window — popups should not overwrite it
        if (win === mainWindow) {
          try { fs.writeFileSync(zoomFilePath, JSON.stringify({ factor: clamped })) } catch {}
        }
      }
    } catch {}
  })
  ipcMain.handle('get-zoom-factor', event => {
    try {
      const f = BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1
      return isFinite(f) ? f : 1
    } catch { return 1 }
  })

  // ── Devtools ────────────────────────────────────────────────────────────────
  ipcMain.on('toggle-devtools', event => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.webContents.isDevToolsOpened()
          ? win.webContents.closeDevTools()
          : win.webContents.openDevTools()
      }
    } catch {}
  })

  // ── File download ───────────────────────────────────────────────────────────
  ipcMain.handle('download-file', async (event, { url, defaultPath }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { success: false, error: 'No window' }
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false, error: 'Invalid URL protocol' }
      }
      // Sanitize defaultPath to a filename only — prevents renderer from pre-seeding
      // the dialog to overwrite sensitive system files via an absolute path.
      // ASCII-only allowlist — strips Unicode homoglyphs, RTLO, and other confusables.
      // Also reject pure-dot names (e.g. "..") which some dialogs treat as directory refs.
      const rawName = path.basename(String(defaultPath ?? 'download')).replace(/[^A-Za-z0-9 .\-_]/g, '_')
      const safeName = (rawName && !/^\.+$/.test(rawName)) ? rawName : 'download'
      const result = await dialog.showSaveDialog(win, { defaultPath: safeName })
      if (result.canceled || !result.filePath) return { success: false }
      await downloadToFile(url, result.filePath)
      return { success: true, path: result.filePath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ── Notifications ───────────────────────────────────────────────────────────
  ipcMain.handle('show-notification', async (_e, options) => {
    if (activeNotifications.size >= 50) return { id: null }
    const id = `n-${crypto.randomUUID()}`
    if (!Notification.isSupported()) return { id }
    try {
      let url = null
      if (typeof options.url === 'string') {
        try {
          const p = new URL(options.url)
          if (['http:', 'https:', 'mailto:'].includes(p.protocol)) url = options.url
        } catch {}
      }
      // Convert data URI to NativeImage — Notification.icon expects a NativeImage
      // or file path, not a raw data URI. Also validates through Electron's image
      // pipeline and caps size to prevent DoS via large icon payloads.
      let notifIcon
      if (options.icon && typeof options.icon === 'string' &&
          (options.icon.startsWith('data:image/png;base64,') || options.icon.startsWith('data:image/jpeg;base64,')) &&
          options.icon.length <= 2 * 1024 * 1024) {
        try { notifIcon = nativeImage.createFromDataURL(options.icon) } catch {}
      }
      const n = new Notification({
        title: String(options.title ?? 'Notification').slice(0, 256),
        body: String(options.body ?? '').slice(0, 1024),
        // Suppress system sound when a custom sound is configured so we can
        // play our own file instead. Honour options.silent unconditionally.
        silent: Boolean(options.silent) || !!_notifSoundPath,
        ...(notifIcon ? { icon: notifIcon } : {}),
      })
      // Auto-cleanup after 30s in case 'close' event never fires on this platform
      const autoCleanTimeout = setTimeout(() => {
        const entry = activeNotifications.get(id)
        if (entry) {
          try { entry.notification.close() } catch {}
          activeNotifications.delete(id)
        }
      }, 30_000)
      activeNotifications.set(id, { notification: n, url, autoCleanTimeout })
      n.on('click', () => {
        clearTimeout(autoCleanTimeout)
        activeNotifications.delete(id)
        if (isWindowReady()) {
          mainWindow.show()
          mainWindow.focus()
          if (url) mainWindow.webContents.send('notification-click', id, url)
        }
      })
      n.on('close', () => {
        clearTimeout(autoCleanTimeout)
        activeNotifications.delete(id)
      })
      n.show()
      // Play custom sound after showing. Skip if the caller explicitly requested
      // silence — that flag suppresses both the system sound AND our custom one.
      if (!Boolean(options.silent)) playNotificationSound()
    } catch (err) {
      console.error('[Notification] Failed to show:', err)
    }
    return { id }
  })
  ipcMain.on('close-notification', (_e, id) => {
    if (typeof id !== 'string') return
    try {
      const entry = activeNotifications.get(id)
      if (entry) {
        clearTimeout(entry.autoCleanTimeout)
        entry.notification.close()
        activeNotifications.delete(id)
      }
    } catch {}
  })
  ipcMain.on('close-notifications', (_e, ids) => {
    if (!Array.isArray(ids)) return
    const limit = Math.min(ids.length, 200)
    for (let i = 0; i < limit; i++) {
      const id = ids[i]
      if (typeof id !== 'string') continue
      try {
        const entry = activeNotifications.get(id)
        if (entry) {
          clearTimeout(entry.autoCleanTimeout)
          entry.notification.close()
          activeNotifications.delete(id)
        }
      } catch {}
    }
  })

  // ── Custom notification sound ────────────────────────────────────────────────
  ipcMain.handle('notification-sound-pick', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return await pickNotificationSound(win)
  })
  ipcMain.handle('notification-sound-clear', () => { clearNotificationSound(); return true })
  ipcMain.handle('notification-sound-get', () => _notifSoundPath ? path.basename(_notifSoundPath) : null)
  ipcMain.handle('notification-sound-preview', () => { playNotificationSound(); return true })

  // ── Spellcheck stubs ────────────────────────────────────────────────────────
  ipcMain.handle('spellcheck-get-state', () => ({ enabled: false, languages: [] }))
  ipcMain.handle('spellcheck-set-state', () => ({ enabled: false, languages: [] }))
  ipcMain.handle('spellcheck-get-available-languages', () => [])
  ipcMain.handle('spellcheck-open-language-settings', () => false)
  ipcMain.handle('spellcheck-replace-misspelling', () => {})
  ipcMain.handle('spellcheck-add-word-to-dictionary', () => {})
  ipcMain.on('spellcheck-context-target', () => {})

  // ── Passkey stubs ───────────────────────────────────────────────────────────
  ipcMain.handle('passkey-is-supported', () => false)
  ipcMain.handle('passkey-authenticate', () => { throw new Error('Passkey not supported') })
  ipcMain.handle('passkey-register', () => { throw new Error('Passkey not supported') })

  // ── Updater stubs ───────────────────────────────────────────────────────────
  ipcMain.handle('updater-check', () => ({ updateAvailable: false, version: null }))
  ipcMain.handle('updater-install', () => ({ success: false, error: 'Not supported' }))

  // ── Global key hook (PTT + keybinds) ────────────────────────────────────────
  ipcMain.handle('global-key-hook-start', () => startHook())
  ipcMain.handle('global-key-hook-stop', () => { stopHook(); return true })
  ipcMain.handle('global-key-hook-is-running', () => hookStarted)
  ipcMain.handle('check-input-monitoring-access', () => true)
  ipcMain.handle('global-key-hook-register', (_e, options) => {
    if (typeof options?.id !== 'string' || !options.id || options.id.length > 128) return false
    if (registeredKeybinds.size >= 64 && !registeredKeybinds.has(options.id)) return false
    // Distinguish "not provided" (undefined) from "provided as 0" (valid on some platforms)
    const keycodeProvided = Number.isInteger(options.keycode) && options.keycode >= 0
    const keycode = keycodeProvided ? options.keycode : 0
    const mouseButton = Number.isInteger(options.mouseButton) &&
      options.mouseButton >= 1 && options.mouseButton <= 5
      ? options.mouseButton : undefined
    // Require at least one trigger to be explicitly provided
    if (!keycodeProvided && mouseButton === undefined) return false
    registeredKeybinds.set(options.id, {
      id: options.id,
      keycode,
      mouseButton,
      modifiers: {
        ctrl: Boolean(options.ctrl),
        alt: Boolean(options.alt),
        shift: Boolean(options.shift),
        meta: Boolean(options.meta),
      },
    })
    return true
  })
  ipcMain.handle('global-key-hook-unregister', (_e, id) => {
    const existed = registeredKeybinds.has(id)
    registeredKeybinds.delete(id)
    return existed // Return boolean, consistent with unregister-all returning true
  })
  ipcMain.handle('global-key-hook-unregister-all', () => { registeredKeybinds.clear(); return true })

  // ── Server URL config ───────────────────────────────────────────────────────
  ipcMain.handle('config-get-server-url-current', () => appUrl || APP_URL)
  ipcMain.handle('configure-server', () => showConfigWindow())
  ipcMain.on('config-cancel-first-run', event => {
    // Only accept from the config window itself, not from other renderers
    if (!configWindow || event.sender.id !== configWindow.webContents.id) return
    isQuitting = true; app.quit()
  })
  // Use handle so the renderer can await acknowledgement before closing its window
  ipcMain.handle('config-set-server-url', (_e, url) => {
    try {
      const p = new URL(url)
      if (!['http:', 'https:'].includes(p.protocol)) return false
      appUrl = url
      saveServerUrl(url)
      // Destroy the config window immediately to prevent a second IPC call racing in
      if (configWindow && !configWindow.isDestroyed()) {
        try { configWindow.destroy() } catch {}
        configWindow = null
      }
      if (isWindowReady()) {
        // Reconfiguring an existing session — just reload
        mainWindow.loadURL(appUrl)
      } else {
        // First run — main window doesn't exist yet, create it now
        try {
          createWindow()
          createTray()
        } catch (err) {
          console.error('[Config] Failed to create window on first run:', err)
          app.quit()
        }
      }
      return true
    } catch { return false }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Config window  (Change Server URL)
// ─────────────────────────────────────────────────────────────────────────────
function showConfigWindow(firstRun = false) {
  if (configWindow && !configWindow.isDestroyed()) { configWindow.focus(); return }
  configWindow = new BrowserWindow({
    width: 480,
    height: firstRun ? 280 : 230,
    resizable: false,
    title: firstRun ? `Welcome to ${APP_NAME}` : `${APP_NAME} — Configure Server`,
    autoHideMenuBar: true,
    webPreferences: {
      // No nodeIntegration — the config preload uses contextBridge to expose only
      // the two IPC calls this window needs (set-server-url, cancel-first-run).
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'config-preload.js'),
    },
  })
  // firstRun is a boolean — JSON.stringify produces "true" or "false", never injectable
  const firstRunJson = JSON.stringify(firstRun)
  // Server URL is fetched from the main process at runtime (no string interpolation into script)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
  body{background:#1a1a2e;color:#ccc;font-family:sans-serif;padding:24px;margin:0}
  h2{margin:0 0 14px;color:#fff;font-size:16px}
  .sub{font-size:12px;opacity:.55;margin:-10px 0 16px}
  label{display:block;margin-bottom:8px;font-size:13px;opacity:.8}
  input{width:100%;padding:8px 10px;background:#2a2a4e;color:#fff;border:1px solid #444;
        border-radius:5px;font-size:14px;box-sizing:border-box;outline:none}
  input:focus{border-color:#7c3aed}
  .row{display:flex;gap:8px;margin-top:14px}
  button{flex:1;padding:9px 0;background:#7c3aed;color:#fff;border:none;
         border-radius:5px;font-size:13px;cursor:pointer}
  button:hover{background:#6d28d9}
  .cancel{background:#333}.cancel:hover{background:#444}
  .hint{font-size:11px;opacity:.5;margin-top:8px}
  .err{font-size:12px;color:#e06c75;margin-top:6px;min-height:16px}
</style></head><body>
${firstRun ? `<h2>Connect to a Fluxer Server</h2><p class="sub">Enter the address of your Fluxer instance to get started.</p>` : ''}
<label>Server URL</label>
<input type="text" id="u" value="" placeholder="https://chat.example.com">
<p class="hint">e.g. https://chat.example.com &nbsp;or&nbsp; http://192.168.1.10:3000</p>
<p class="err" id="err"></p>
<div class="row">
  <button onclick="save()">${firstRun ? 'Connect' : 'Save &amp; Reconnect'}</button>
  <button class="cancel" onclick="cancel()">${firstRun ? 'Quit' : 'Cancel'}</button>
</div>
<script>
const FIRST_RUN=${firstRunJson}
const inp=document.getElementById('u')
// Fetch current server URL from main process — no string interpolation into script
window.configApi.getServerUrl().then(url=>{inp.value=url;inp.select()})
async function save(){
  const v=inp.value.trim()
  if(!v){document.getElementById('err').textContent='Please enter a URL.';return}
  try{const p=new URL(v);if(!['http:','https:'].includes(p.protocol)){throw new Error()}}
  catch{document.getElementById('err').textContent='Must start with http:// or https://';return}
  // Await acknowledgement from main before closing so the IPC message is not lost
  await window.configApi.setServerUrl(v)
  window.close()
}
function cancel(){
  if(FIRST_RUN){window.configApi.cancelFirstRun()}
  window.close()
}
inp.addEventListener('keydown',e=>{if(e.key==='Enter')save()})
</script></body></html>`
  // Block all navigation — will-navigate does not fire for the initial loadURL,
  // only for page-initiated navigations, so blocking unconditionally is safe.
  configWindow.webContents.on('will-navigate', event => {
    event.preventDefault()
  })
  configWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  configWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  configWindow.on('closed', () => {
    configWindow = null
    // If user closes the first-run window without saving, quit.
    // Guard isQuitting to avoid a double-quit if cancel() already triggered it.
    if (firstRun && !isWindowReady() && !isQuitting) { isQuitting = true; app.quit() }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────
function createWindow() {
  const icon = nativeImage.createFromPath(ICON_PATH)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: APP_NAME,
    icon,
    backgroundColor: '#1a1a2e',
    // Remove OS title bar — Fluxer renders its own.
    // On macOS keep frame:true so traffic lights are preserved; titleBarStyle:'hidden'
    // hides the macOS title bar text while keeping the traffic light hitbox.
    frame: process.platform !== 'darwin',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: true,
    show: false,
  })

  // Remove the application menu so Alt doesn't flash a menu bar on Windows
  Menu.setApplicationMenu(null)

  // Permission grants for mic, camera, notifications, screen capture, etc.
  const ALLOWED_PERMISSIONS = [
    'notifications', 'media', 'mediaKeySystem',
    'microphone', 'camera', 'display-capture',
    'audioCapture', 'videoCapture',
    'clipboard-read', 'clipboard-sanitized-write',
    'fullscreen', 'geolocation',
  ]
  // Async handler — called when the web app actively requests a permission
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission))
  })
  // Sync handler — called when Chromium checks a permission without prompting.
  // Must be set alongside setPermissionRequestHandler or some media features
  // (e.g. WebRTC video tracks, screen capture) silently fail the pre-check.
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return ALLOWED_PERMISSIONS.includes(permission)
  })

  // Intercept getDisplayMedia() — route through Fluxer's built-in picker UI
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    // Rate-limit: reject if too many requests are already pending
    if (pendingDisplayRequests.size >= 10) {
      try { callback({ video: null }) } catch {}
      return
    }
    const requestId = `dmr-${crypto.randomUUID()}`
    const timeout = setTimeout(() => {
      const req = pendingDisplayRequests.get(requestId)
      if (req) {
        pendingDisplayRequests.delete(requestId)
        cachedSources.clear() // prevent stale source leak on timeout
        try { req.callback({ video: null }) } catch {}
      }
    }, 60_000)
    pendingDisplayRequests.set(requestId, { callback, timeout })

    try {
      if (!isWindowReady()) {
        clearTimeout(timeout)
        pendingDisplayRequests.delete(requestId)
        cachedSources.clear()
        try { callback({ video: null }) } catch {}
        return
      }
      // Only pass the origin if it matches the app's own host AND protocol —
      // otherwise a third-party/downgraded iframe's origin would be leaked.
      let frameOrigin = new URL(appUrl).origin
      try {
        const u = new URL(request.requestingFrame?.url ?? appUrl)
        const a = new URL(appUrl)
        if (u.host === a.host && u.protocol === a.protocol) frameOrigin = u.origin
      } catch {}
      mainWindow.webContents.send('display-media-requested', requestId, {
        origin: frameOrigin,
      })
    } catch (err) {
      // If we can't notify the renderer, cancel immediately
      clearTimeout(timeout)
      pendingDisplayRequests.delete(requestId)
      cachedSources.clear()
      try { callback({ video: null }) } catch {}
    }
  }, { useSystemPicker: false })

  // Forward maximize state to the web app
  mainWindow.on('maximize', () => {
    try { mainWindow.webContents.send('window-maximize-change', true) } catch {}
  })
  mainWindow.on('unmaximize', () => {
    try { mainWindow.webContents.send('window-maximize-change', false) } catch {}
  })

  // zoomFilePath is used both in did-finish-load (restore) and the set-zoom-factor handler
  const zoomFilePath = path.join(app.getPath('userData'), 'zoom.json')

  mainWindow.loadURL(appUrl)
  mainWindow.once('ready-to-show', () => { try { if (!mainWindow.isDestroyed()) mainWindow.show() } catch {} })

  // Show a friendly error page if the server is unreachable
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // Skip our own generated error pages (data: URLs) and internal chrome pages
    if (validatedURL && (
      validatedURL.startsWith('data:') ||
      validatedURL.startsWith('chrome://') ||
      validatedURL.startsWith('chrome-error://')
    )) return
    if (!isWindowReady()) return
    if (isQuitting) return
    if (!mainWindow.isVisible()) mainWindow.show()
    let hint = ''
    if (errorCode === -105) {
      hint = '<p class="hint">Tip: Windows Firewall may be blocking this app, or the hostname is only reachable on your LAN/VPN. Try setting the server\'s IP address with <strong>Change Server URL</strong>.</p>'
    } else if (errorCode === -21) {
      hint = '<p class="hint">Tip: No internet connection detected — check your network.</p>'
    } else if (errorCode === -102) {
      hint = '<p class="hint">Tip: Connection refused — the server may be offline or listening on a different port.</p>'
    } else if (errorCode === -118) {
      hint = '<p class="hint">Tip: Connection timed out — the server may be unreachable or behind a firewall.</p>'
    }
    // Replace < with its unicode escape so the HTML parser never sees a tag
    // boundary inside the <script> block, regardless of what appUrl contains.
    const serverUrlJson = JSON.stringify(appUrl)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connection Failed</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
  body{background:#1a1a2e;color:#ccc;font-family:sans-serif;display:flex;
       flex-direction:column;align-items:center;justify-content:center;
       height:100vh;margin:0;-webkit-app-region:no-drag;text-align:center;padding:20px;box-sizing:border-box}
  h1{color:#e06c75;margin-bottom:8px}
  .hint{font-size:12px;color:#f0a500;max-width:480px;margin:8px 0}
  .btns{display:flex;gap:10px;margin-top:18px;justify-content:center}
  button{padding:10px 22px;background:#7c3aed;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}
  button:hover{background:#6d28d9}
  button.sec{background:#444}button.sec:hover{background:#555}
  #cnt{font-size:11px;opacity:.45;margin-top:10px}
</style></head><body>
<h1>Connection Failed</h1>
<p>Unable to reach <strong>${escHtml(appUrl)}</strong></p>
<p style="font-size:12px;opacity:.6">${escHtml(String(errorDescription).substring(0, 200))} (${Number(errorCode)})</p>
${hint}
<div class="btns">
  <button onclick="retry()">Retry Now</button>
  <button class="sec" onclick="configure()">Change Server URL</button>
</div>
<p id="cnt">Retrying in <span id="s">5</span>s&hellip;</p>
<script>
const SERVER=${serverUrlJson}
let t=5
const si=setInterval(()=>{t--;document.getElementById('s').textContent=t;if(t<=0){clearInterval(si);retry()}},1000)
function retry(){clearInterval(si);location.href=SERVER}
function configure(){if(window.electron&&window.electron.configureServer){clearInterval(si);window.electron.configureServer()}}
</script></body></html>`
    mainWindow.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })

  // CSS drag-region fallback — ensures window is draggable on frameless platforms
  // even if Fluxer's own CSS hasn't set -webkit-app-region:drag yet
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isWindowReady()) return
    // Skip error pages and internal pages — only inject into real app content
    const loadedUrl = mainWindow.webContents.getURL()
    if (loadedUrl.startsWith('data:') || loadedUrl.startsWith('chrome://') || loadedUrl.startsWith('chrome-error://')) return
    // Restore persisted zoom here — Electron ≥ 28 resets zoom to 1.0 on each navigation,
    // so setZoomFactor called before loadURL has no lasting effect.
    try {
      const saved = JSON.parse(fs.readFileSync(zoomFilePath, 'utf8'))
      const factor = Number(saved?.factor)
      if (isFinite(factor) && factor >= 0.5 && factor <= 3.0) {
        mainWindow.webContents.setZoomFactor(factor)
      }
    } catch {}
    mainWindow.webContents.insertCSS(`
      [class*="titleBar"i]:not(button):not(input):not(a),
      [class*="title-bar"i]:not(button):not(input):not(a),
      [class*="topBar"i]:not(button):not(input):not(a) {
        -webkit-app-region: drag;
      }
      [class*="titleBar"i] button, [class*="titleBar"i] input, [class*="titleBar"i] a,
      [class*="title-bar"i] button, [class*="title-bar"i] input, [class*="title-bar"i] a {
        -webkit-app-region: no-drag;
      }
    `).catch(err => console.debug('[DragRegion] CSS injection failed:', err.message))
  })

  // Clear registered keybinds and global shortcuts on navigation so stale binds
  // don't fire into the new page. Also cancel pending display-media requests.
  mainWindow.webContents.on('did-navigate', () => {
    registeredKeybinds.clear()
    // Unregister only the shortcuts we own — avoids nuking any shortcuts that
    // other Electron internal code may have registered on the same instance.
    for (const accelerator of registeredShortcuts.keys()) {
      try { globalShortcut.unregister(accelerator) } catch {}
    }
    registeredShortcuts.clear()
    for (const req of pendingDisplayRequests.values()) {
      clearTimeout(req.timeout)
      try { req.callback({ video: null }) } catch {}
    }
    pendingDisplayRequests.clear()
    cachedSources.clear()
  })

  // Intercept Ctrl+=/−/0 and forward as zoom IPC events to the web app.
  // event.preventDefault() stops the browser's own zoom from also firing.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return
    if (input.type !== 'keyDown') return
    if (!isWindowReady()) return
    if (input.key === '=' || input.key === '+') {
      event.preventDefault()
      mainWindow.webContents.send('zoom-in')
    } else if (input.key === '-') {
      event.preventDefault()
      mainWindow.webContents.send('zoom-out')
    } else if (input.key === '0') {
      event.preventDefault()
      mainWindow.webContents.send('zoom-reset')
    }
  })

  // Hide to tray on close; show a one-time hint the first time
  const trayHintFlagPath = path.join(app.getPath('userData'), 'tray-hint-shown')
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault()
      try { mainWindow.hide() } catch {}
      try {
        // Atomic exclusive create — fails if the file already exists, eliminating
        // the TOCTOU window between existsSync and writeFileSync.
        fs.writeFileSync(trayHintFlagPath, '1', { flag: 'wx' })
        // Only reached if this is the first close (file didn't exist)
        if (tray && Notification.isSupported()) {
          new Notification({ title: APP_NAME, body: 'Fluxer is still running in the system tray.' }).show()
        }
      } catch {}
    }
  })

  // Same-origin popups get the preload so window.electron is available
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let sameOrigin = false
    try {
      const u = new URL(url)
      const a = new URL(appUrl)
      // Require both protocol and host to match — allowing http: when the app uses
      // https: would let a MITM server serve content that gets the preload injected.
      sameOrigin = u.protocol === a.protocol && u.host === a.host
    } catch {}
    if (sameOrigin) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        },
      }
    }
    try {
      const parsed = new URL(url)
      if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(url)
    } catch {}
    return { action: 'deny' }
  })

  // Attach security guards to same-origin popups opened by setWindowOpenHandler.
  // Without this, a popup can navigate to a third-party page that still has the
  // preload / window.electron API available.
  mainWindow.webContents.on('did-create-window', popup => {
    // Capture host AND protocol at popup-open time so that a later appUrl change
    // (via "Change Server URL") cannot grant this popup access to the new server,
    // and so a protocol-downgrade (https→http) on the same host is also blocked.
    let expectedPopupHost = ''
    let expectedPopupProtocol = ''
    try {
      const a = new URL(appUrl)
      expectedPopupHost = a.host
      expectedPopupProtocol = a.protocol
    } catch {}
    popup.webContents.on('will-navigate', (event, url) => {
      let isAppOrigin = false
      try {
        const u = new URL(url)
        isAppOrigin = u.protocol === expectedPopupProtocol && u.host === expectedPopupHost
      } catch {}
      if (!isAppOrigin) {
        event.preventDefault()
        try {
          const parsed = new URL(url)
          if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(url)
        } catch {}
      }
    })
    // Prevent popups from spawning further popups
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  // Block navigation away from the app domain
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isAppOrigin = false
    try {
      const u = new URL(url)
      const a = new URL(appUrl)
      // Compare host:port (protocol-independent, consistent with setWindowOpenHandler).
      // Require http/https to exclude data:, javascript:, chrome:, etc.
      isAppOrigin = ['http:', 'https:'].includes(u.protocol) && u.host === a.host
    } catch {}
    if (!isAppOrigin) {
      event.preventDefault()
      try {
        const parsed = new URL(url)
        if (['http:', 'https:'].includes(parsed.protocol)) shell.openExternal(url)
      } catch {}
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tray
// ─────────────────────────────────────────────────────────────────────────────
function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Fluxer',
      click: () => {
        if (!isWindowReady()) { createWindow(); return }
        mainWindow.show()
        mainWindow.focus()
      },
    },
    { type: 'separator' },
    {
      label: 'Theme',
      submenu: [
        {
          label: 'Dark',
          type: 'radio',
          checked: currentTheme === 'dark',
          click: () => applyTheme('dark'),
        },
        {
          label: 'Light',
          type: 'radio',
          checked: currentTheme === 'light',
          click: () => applyTheme('light'),
        },
        {
          label: 'System',
          type: 'radio',
          checked: currentTheme === 'system',
          click: () => applyTheme('system'),
        },
      ],
    },
    {
      label: 'Notification Sound',
      submenu: [
        {
          label: _notifSoundPath ? `Current: ${path.basename(_notifSoundPath)}` : 'Set Custom Sound…',
          click: () => pickNotificationSound(),
        },
        ...(_notifSoundPath ? [
          { label: 'Preview Sound', click: () => playNotificationSound() },
          { label: 'Clear Custom Sound', click: () => clearNotificationSound() },
        ] : []),
      ],
    },
    { type: 'separator' },
    { label: 'Settings', click: () => { if (isWindowReady()) mainWindow.webContents.send('open-settings') } },
    { label: 'Change Server URL…', click: () => showConfigWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  tray = new Tray(nativeImage.createFromPath(ICON_PATH))
  tray.setToolTip(APP_NAME)
  rebuildTrayMenu()

  // Single click toggles visibility (Discord/Slack behaviour)
  tray.on('click', () => {
    if (!isWindowReady()) { createWindow(); return }
    try {
      const visible = mainWindow.isVisible()
      const minimized = mainWindow.isMinimized()
      const focused = mainWindow.isFocused()
      if (visible && !minimized && focused) {
        mainWindow.hide()
      } else {
        if (minimized) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    } catch {}
  })
  tray.on('double-click', () => {
    if (!isWindowReady()) { createWindow(); return }
    try { mainWindow.show(); mainWindow.focus() } catch {}
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const savedUrl = loadServerUrl()
  if (savedUrl) appUrl = savedUrl // keep APP_URL as fallback so appUrl is never null
  currentTheme = loadTheme()
  nativeTheme.themeSource = currentTheme
  loadNotificationSound()
  registerIpcHandlers()
  if (savedUrl) {
    // Returning user — go straight to the app
    createWindow()
    createTray()
  } else {
    // First run — ask which server to connect to before opening the main window
    showConfigWindow(true)
  }
}).catch(err => {
  console.error('[App] Fatal startup error:', err)
  app.quit()
})

app.on('window-all-closed', () => { /* stay alive in tray */ })
app.on('activate', () => {
  // If the first-run config window is open, don't bypass it by creating the main window
  if (configWindow && !configWindow.isDestroyed()) return
  if (!isWindowReady()) createWindow()
  if (!tray || tray.isDestroyed()) createTray()
})
app.on('before-quit', () => {
  isQuitting = true
  stopHook()
  clearTimeout(_badgeDebounceTimer)
  globalShortcut.unregisterAll()
  registeredShortcuts.clear()

  // Cancel all pending display requests
  for (const req of pendingDisplayRequests.values()) {
    clearTimeout(req.timeout)
    try { req.callback({ video: null }) } catch {}
  }
  pendingDisplayRequests.clear()
  cachedSources.clear()

  // Close all active notifications properly
  for (const entry of activeNotifications.values()) {
    clearTimeout(entry.autoCleanTimeout)
    try { entry.notification.close() } catch {}
  }
  activeNotifications.clear()

  // Close config window if open
  if (configWindow && !configWindow.isDestroyed()) {
    try { configWindow.destroy() } catch {}
    configWindow = null
  }
})
