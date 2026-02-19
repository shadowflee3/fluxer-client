const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
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
let displayRequestCounter = 0
const cachedSources = new Map()

// ── Global shortcuts ──────────────────────────────────────────────────────────
const registeredShortcuts = new Map()

// ── Notifications ─────────────────────────────────────────────────────────────
const activeNotifications = new Map() // id → { notification, url, autoCleanTimeout }
let notificationIdCounter = 0

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

function saveServerUrl(url) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'config.json'),
      JSON.stringify({ serverUrl: url })
    )
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

async function startHook() {
  if (hookStarted) return true
  try {
    const mod = require('uiohook-napi')
    uIOhook = mod.uIOhook
    UiohookKey = mod.UiohookKey
    uIOhook.removeAllListeners()
    uIOhook.on('keydown', e => handleKeyEvent(e, 'keydown'))
    uIOhook.on('keyup', e => handleKeyEvent(e, 'keyup'))
    uIOhook.on('mousedown', e => handleMouseEvent(e, 'mousedown'))
    uIOhook.on('mouseup', e => handleMouseEvent(e, 'mouseup'))
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
  }
}

function stopHook() {
  if (!hookStarted || !uIOhook) return
  try { uIOhook.stop() } catch {}
  // Remove listeners so handleKeyEvent/handleMouseEvent cannot fire
  // between stop and the next startHook() call
  try { uIOhook.removeAllListeners() } catch {}
  hookStarted = false
}

// ─────────────────────────────────────────────────────────────────────────────
// File download helper
// ─────────────────────────────────────────────────────────────────────────────
function downloadToFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) { reject(new Error('Too many redirects')); return }
    const protocol = url.toLowerCase().startsWith('https://') ? https : http
    const file = fs.createWriteStream(destPath)
    let settled = false
    const settle = (fn, val) => {
      if (settled) return
      settled = true
      try { file.close() } catch {}
      fn(val)
    }
    const cleanup = () => fs.unlink(destPath, () => {})

    const req = protocol.get(url, response => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const location = response.headers.location
        if (!location) { cleanup(); settle(reject, new Error('Redirect without Location')); return }
        // Mark settled before destroying so the req.on('error') handler below
        // cannot spuriously reject if req emits an error after destruction.
        settled = true
        try { file.destroy() } catch {}
        cleanup()
        try { req.destroy() } catch {}
        downloadToFile(location, destPath, redirects + 1).then(resolve).catch(reject)
        return
      }
      if (response.statusCode !== 200) {
        cleanup(); settle(reject, new Error(`HTTP ${response.statusCode}`)); return
      }
      response.on('error', err => { cleanup(); settle(reject, err) })
      response.pipe(file)
      file.on('finish', () => settle(resolve))
    })
    req.on('error', err => { cleanup(); settle(reject, err) })
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
  ipcMain.handle('clipboard-write-text', (_e, text) => clipboard.writeText(String(text ?? '')))
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
  ipcMain.handle('app-set-badge', (_e, count) => { try { app.badgeCount = count ?? 0 } catch {} })
  ipcMain.on('set-badge-count', (_e, count) => { try { app.badgeCount = count ?? 0 } catch {} })
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
        try { fs.writeFileSync(zoomFilePath, JSON.stringify({ factor: clamped })) } catch {}
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
      const result = await dialog.showSaveDialog(win, { defaultPath })
      if (result.canceled || !result.filePath) return { success: false }
      await downloadToFile(url, result.filePath)
      return { success: true, path: result.filePath }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ── Notifications ───────────────────────────────────────────────────────────
  ipcMain.handle('show-notification', async (_e, options) => {
    const id = `n-${++notificationIdCounter}`
    if (!Notification.isSupported()) return { id }
    try {
      let url = null
      if (typeof options.url === 'string') {
        try {
          const p = new URL(options.url)
          if (['http:', 'https:', 'mailto:'].includes(p.protocol)) url = options.url
        } catch {}
      }
      const n = new Notification({
        title: String(options.title ?? 'Notification'),
        body: String(options.body ?? ''),
        silent: Boolean(options.silent),
        ...(options.icon && typeof options.icon === 'string' &&
        (options.icon.startsWith('data:') || options.icon.startsWith('https://') || options.icon.startsWith('http://'))
        ? { icon: options.icon } : {}),
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
    } catch (err) {
      console.error('[Notification] Failed to show:', err)
    }
    return { id }
  })
  ipcMain.on('close-notification', (_e, id) => {
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
    for (const id of ids) {
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
    if (typeof options?.id !== 'string' || !options.id) return false
    const keycode = Number.isInteger(options.keycode) && options.keycode >= 0 ? options.keycode : 0
    const mouseButton = Number.isInteger(options.mouseButton) ? options.mouseButton : undefined
    // Require at least one trigger — keycode 0 with no mouseButton would match nothing
    if (keycode === 0 && mouseButton === undefined) return false
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
  ipcMain.handle('configure-server', () => showConfigWindow())
  ipcMain.on('config-cancel-first-run', () => { isQuitting = true; app.quit() })
  ipcMain.on('config-set-server-url', (_e, url) => {
    try {
      const p = new URL(url)
      if (!['http:', 'https:'].includes(p.protocol)) return
      appUrl = url
      saveServerUrl(url)
      if (isWindowReady()) {
        // Reconfiguring an existing session — just reload
        mainWindow.loadURL(appUrl)
      } else {
        // First run — main window doesn't exist yet, create it now
        createWindow()
        createTray()
      }
    } catch {}
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
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  Menu.setApplicationMenu(null)
  const serverUrlJson = JSON.stringify(appUrl || APP_URL)
  const firstRunJson = JSON.stringify(firstRun)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
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
const {ipcRenderer}=require('electron')
const SERVER_URL=${serverUrlJson}
const FIRST_RUN=${firstRunJson}
const inp=document.getElementById('u')
inp.value=SERVER_URL
inp.select()
function save(){
  const v=inp.value.trim()
  if(!v){document.getElementById('err').textContent='Please enter a URL.';return}
  try{const p=new URL(v);if(!['http:','https:'].includes(p.protocol)){throw new Error()}}
  catch{document.getElementById('err').textContent='Must start with http:// or https://';return}
  ipcRenderer.send('config-set-server-url',v)
  window.close()
}
function cancel(){
  if(FIRST_RUN){ipcRenderer.send('config-cancel-first-run')}
  window.close()
}
inp.addEventListener('keydown',e=>{if(e.key==='Enter')save()})
</script></body></html>`
  configWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // Block any navigation away from the inline data: URL — nodeIntegration is enabled
  // so an unguarded external navigation would give full Node.js access to a remote page.
  configWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:')) event.preventDefault()
  })
  configWindow.on('closed', () => {
    configWindow = null
    // If user closes the first-run window without saving, quit
    if (firstRun && !isWindowReady()) app.quit()
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
    const requestId = `dmr-${++displayRequestCounter}`
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
      mainWindow.webContents.send('display-media-requested', requestId, {
        origin: request.requestingFrame?.url ?? appUrl,
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

  // Restore persisted zoom before page loads
  const zoomFilePath = path.join(app.getPath('userData'), 'zoom.json')
  try {
    const saved = JSON.parse(fs.readFileSync(zoomFilePath, 'utf8'))
    const factor = Number(saved?.factor)
    if (isFinite(factor) && factor >= 0.5 && factor <= 3.0) {
      mainWindow.webContents.setZoomFactor(factor)
    }
  } catch {}

  mainWindow.loadURL(appUrl)
  mainWindow.once('ready-to-show', () => { if (!mainWindow.isDestroyed()) mainWindow.show() })

  // Show a friendly error page if the server is unreachable
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // Skip our own generated error pages (data: URLs) and internal chrome:// pages
    if (validatedURL && (validatedURL.startsWith('data:') || validatedURL.startsWith('chrome'))) return
    if (!isWindowReady()) return
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
    const serverUrlJson = JSON.stringify(appUrl)
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connection Failed</title>
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

  // Clear registered keybinds on navigation so stale binds don't fire twice.
  // Also cancel pending display-media requests whose renderer UI is now gone.
  mainWindow.webContents.on('did-navigate', () => {
    registeredKeybinds.clear()
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
      if (!fs.existsSync(trayHintFlagPath)) {
        try { fs.writeFileSync(trayHintFlagPath, '1') } catch {}
        if (tray && Notification.isSupported()) {
          try { new Notification({ title: APP_NAME, body: 'Fluxer is still running in the system tray.' }).show() } catch {}
        }
      }
    }
  })

  // Same-origin popups get the preload so window.electron is available
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let sameOrigin = false
    try { sameOrigin = new URL(url).origin === new URL(appUrl).origin } catch {}
    if (sameOrigin) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
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

  // Block navigation away from the app domain
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let isAppOrigin = false
    try { isAppOrigin = new URL(url).origin === new URL(appUrl).origin } catch {}
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
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH))
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Fluxer',
      click: () => {
        // Recreate window if somehow destroyed while tray is alive
        if (!isWindowReady()) { createWindow(); return }
        mainWindow.show()
        mainWindow.focus()
      },
    },
    { type: 'separator' },
    { label: 'Change Server URL…', click: () => showConfigWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit() } },
  ]))

  // Single click toggles visibility (Discord/Slack behaviour);
  // handles minimized state correctly
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
  appUrl = loadServerUrl()
  registerIpcHandlers()
  if (appUrl) {
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
app.on('activate', () => { if (!isWindowReady()) createWindow() })
app.on('before-quit', () => {
  isQuitting = true
  stopHook()
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
