const { contextBridge, ipcRenderer } = require('electron')

// Expose the full window.electron API that Fluxer's web app expects.
// The web app checks window.electron to detect the desktop app and enable
// PTT keybinding, screen sharing, notifications, and other desktop features.

// Per-channel handler map — tracks only our own active listener per channel.
// Using removeAllListeners would also remove Electron-internal listeners on the
// same channel; instead we track and remove only the one we registered.
const _channelHandlers = new Map()

const on = (channel, cb) => {
  // Remove our previous listener for this channel (if any) before adding the new one.
  // The web app may call registration functions multiple times (e.g. on re-render),
  // and ipcRenderer.on() does not deduplicate — without this each call stacks a new
  // listener causing duplicate events and memory leaks.
  const prev = _channelHandlers.get(channel)
  if (prev) ipcRenderer.removeListener(channel, prev)
  const h = (_e, ...args) => cb(...args)
  _channelHandlers.set(channel, h)
  ipcRenderer.on(channel, h)
  return () => {
    ipcRenderer.removeListener(channel, h)
    if (_channelHandlers.get(channel) === h) _channelHandlers.delete(channel)
  }
}

const api = {
  platform: process.platform,

  getDesktopInfo: () => ipcRenderer.invoke('get-desktop-info'),

  // Return null for proxy URLs — the web app connects directly to the server
  getWsProxyUrl: () => null,
  getApiProxyUrl: () => null,
  getMediaProxyUrl: () => null,

  // Updater stubs
  onUpdaterEvent: cb => on('updater-event', cb),
  updaterCheck: ctx => ipcRenderer.invoke('updater-check', ctx),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),

  // Window controls
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximizeChange: cb => on('window-maximize-change', cb),

  // External links
  openExternal: url => ipcRenderer.invoke('open-external', url),

  // Clipboard
  clipboardWriteText: text => ipcRenderer.invoke('clipboard-write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard-read-text'),

  // Deep links
  onDeepLink: cb => on('deep-link', cb),
  getInitialDeepLink: () => ipcRenderer.invoke('get-initial-deep-link'),

  // RPC navigate
  onRpcNavigate: cb => on('rpc-navigate', cb),

  // Global shortcuts (Electron accelerator-based, e.g. "Ctrl+Shift+M")
  registerGlobalShortcut: (accelerator, id) =>
    ipcRenderer.invoke('register-global-shortcut', { accelerator, id }),
  unregisterGlobalShortcut: accelerator =>
    ipcRenderer.invoke('unregister-global-shortcut', accelerator),
  unregisterAllGlobalShortcuts: () =>
    ipcRenderer.invoke('unregister-all-global-shortcuts'),
  onGlobalShortcut: cb => on('global-shortcut-triggered', cb),

  // Autostart
  autostartEnable: () => ipcRenderer.invoke('autostart-enable'),
  autostartDisable: () => ipcRenderer.invoke('autostart-disable'),
  autostartIsEnabled: () => ipcRenderer.invoke('autostart-is-enabled'),
  autostartIsInitialized: () => ipcRenderer.invoke('autostart-is-initialized'),
  autostartMarkInitialized: () => ipcRenderer.invoke('autostart-mark-initialized'),

  // Media access (always granted on Windows)
  checkMediaAccess: type => ipcRenderer.invoke('check-media-access', type),
  requestMediaAccess: type => ipcRenderer.invoke('request-media-access', type),
  openMediaAccessSettings: type => ipcRenderer.invoke('open-media-access-settings', type),

  // Accessibility (always granted on Windows)
  checkAccessibility: prompt => ipcRenderer.invoke('check-accessibility', prompt),
  openAccessibilitySettings: () => ipcRenderer.invoke('open-accessibility-settings'),
  openInputMonitoringSettings: () => ipcRenderer.invoke('open-input-monitoring-settings'),

  // File download
  downloadFile: (url, defaultPath) =>
    ipcRenderer.invoke('download-file', { url, defaultPath }),

  // Passkeys (not supported in this wrapper)
  passkeyIsSupported: () => ipcRenderer.invoke('passkey-is-supported'),
  passkeyAuthenticate: options => ipcRenderer.invoke('passkey-authenticate', options),
  passkeyRegister: options => ipcRenderer.invoke('passkey-register', options),

  // Dev tools
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // ── Screen sharing ──────────────────────────────────────────────────────────
  // Fluxer's UI calls getDesktopSources() to populate its own source picker,
  // then calls selectDisplayMediaSource() when the user picks a source.
  // The main process intercepts getDisplayMedia() and sends display-media-requested
  // to trigger Fluxer's built-in picker.
  getDesktopSources: types => ipcRenderer.invoke('get-desktop-sources', types),
  onDisplayMediaRequested: cb => on('display-media-requested', cb),
  selectDisplayMediaSource: (requestId, sourceId, withAudio) =>
    ipcRenderer.send('select-display-media-source', requestId, sourceId, withAudio),

  // Notifications
  showNotification: options => ipcRenderer.invoke('show-notification', options),
  closeNotification: id => ipcRenderer.send('close-notification', id),
  closeNotifications: ids => ipcRenderer.send('close-notifications', ids),
  onNotificationClick: cb => on('notification-click', cb),

  // App badge (Windows taskbar overlay)
  setBadgeCount: count => ipcRenderer.send('set-badge-count', count),
  getBadgeCount: () => ipcRenderer.invoke('get-badge-count'),
  bounceDock: type => ipcRenderer.invoke('bounce-dock', type ?? 'informational'),
  cancelBounceDock: id => ipcRenderer.send('cancel-bounce-dock', id),

  // Zoom
  setZoomFactor: factor => ipcRenderer.send('set-zoom-factor', factor),
  getZoomFactor: () => ipcRenderer.invoke('get-zoom-factor'),
  onZoomIn: cb => on('zoom-in', cb),
  onZoomOut: cb => on('zoom-out', cb),
  onZoomReset: cb => on('zoom-reset', cb),

  // Settings panel
  onOpenSettings: cb => on('open-settings', cb),
  configureServer: () => ipcRenderer.invoke('configure-server'),

  // ── Global key hook — PTT and custom keybinds ───────────────────────────────
  // The web app calls globalKeyHookStart() when the user enables PTT,
  // then globalKeyHookRegister() with the chosen key's uiohook keycode.
  // Main fires global-keybind-triggered events on keydown/keyup globally,
  // even when the app window is not focused.
  globalKeyHookStart: () => ipcRenderer.invoke('global-key-hook-start'),
  globalKeyHookStop: () => ipcRenderer.invoke('global-key-hook-stop'),
  globalKeyHookIsRunning: () => ipcRenderer.invoke('global-key-hook-is-running'),
  checkInputMonitoringAccess: () => ipcRenderer.invoke('check-input-monitoring-access'),
  globalKeyHookRegister: options => ipcRenderer.invoke('global-key-hook-register', options),
  globalKeyHookUnregister: id => ipcRenderer.invoke('global-key-hook-unregister', id),
  globalKeyHookUnregisterAll: () => ipcRenderer.invoke('global-key-hook-unregister-all'),
  onGlobalKeyEvent: cb => on('global-key-event', cb),
  onGlobalMouseEvent: cb => on('global-mouse-event', cb),
  onGlobalKeybindTriggered: cb => on('global-keybind-triggered', cb),

  // Spellcheck stubs
  spellcheckGetState: () => ipcRenderer.invoke('spellcheck-get-state'),
  spellcheckSetState: state => ipcRenderer.invoke('spellcheck-set-state', state),
  spellcheckGetAvailableLanguages: () =>
    ipcRenderer.invoke('spellcheck-get-available-languages'),
  spellcheckOpenLanguageSettings: () =>
    ipcRenderer.invoke('spellcheck-open-language-settings'),
  onSpellcheckStateChanged: cb => on('spellcheck-state-changed', cb),
  onTextareaContextMenu: cb => on('textarea-context-menu', cb),
  spellcheckReplaceMisspelling: word =>
    ipcRenderer.invoke('spellcheck-replace-misspelling', word),
  spellcheckAddWordToDictionary: word =>
    ipcRenderer.invoke('spellcheck-add-word-to-dictionary', word),
}

// Let the spellcheck context menu handler know what's under the cursor.
// Throttled to 100 ms so a page cannot flood the main process IPC queue by
// rapidly dispatching synthetic contextmenu events.
let _contextmenuLastSent = 0
// Reset throttle on navigation so the first right-click on a new page is
// never silently suppressed by a stale timestamp from the previous page.
window.addEventListener('beforeunload', () => { _contextmenuLastSent = 0 })
window.addEventListener('contextmenu', event => {
  const now = Date.now()
  if (now - _contextmenuLastSent < 100) return
  _contextmenuLastSent = now
  // Use nodeName instead of instanceof — instanceof across the context-isolation
  // boundary can fail because the main-world element's prototype chain does not
  // include the isolated world's HTMLTextAreaElement.prototype.
  const isTextarea = event.target?.nodeName === 'TEXTAREA'
  ipcRenderer.send('spellcheck-context-target', { isTextarea })
}, true)

// Expose as window.electron — the exact name Fluxer's web app checks
contextBridge.exposeInMainWorld('electron', api)
