const { contextBridge, ipcRenderer } = require('electron')

// Minimal bridge for the server-URL config window.
// Exposes only what the config page needs — no Node.js access in the renderer.
contextBridge.exposeInMainWorld('configApi', {
  getServerUrl: () => ipcRenderer.invoke('config-get-server-url-current'),
  // invoke (not send) so the renderer can await acknowledgement before window.close().
  // Validate format here so a malformed URL never reaches the main process.
  setServerUrl: url => {
    if (typeof url !== 'string') return Promise.resolve(false)
    const trimmed = url.trim().slice(0, 2048)
    try {
      const p = new URL(trimmed)
      if (!['http:', 'https:'].includes(p.protocol)) return Promise.resolve(false)
    } catch { return Promise.resolve(false) }
    return ipcRenderer.invoke('config-set-server-url', trimmed)
  },
  cancelFirstRun: () => ipcRenderer.send('config-cancel-first-run'),
})
