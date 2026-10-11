// Exposes the native amp engine to the tabShare page as `window.tabshareNative` (see src/rig/native.ts).
const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own pages get the bridge (not the TONE3000 sign-in popup or anything else).
if (location.origin === ipcRenderer.sendSync('app-origin')) {
  let port = null;
  const queue = [];
  const listeners = new Set();

  ipcRenderer.on('engine-port', (e) => {
    // A second port on the same page means the engine process died and was restarted.
    if (port) listeners.forEach((l) => l({ type: 'error', message: 'The audio engine restarted (a plugin may have crashed). Turn the rig back on.' }));
    if (port) listeners.forEach((l) => l({ type: 'stopped' }));
    port = e.ports[0];
    port.onmessage = (m) => listeners.forEach((l) => l(m.data));
    queue.splice(0).forEach((m) => port.postMessage(m));
  });

  contextBridge.exposeInMainWorld('tabshareNative', {
    platform: process.platform,
    send: (msg) => (port ? port.postMessage(msg) : queue.push(msg)),
    /** cb(false) when focus leaves every tabShare window, cb(true) when the main window gets it back. */
    onAppFocus: (cb) => {
      const h = (_e, focused) => cb(focused);
      ipcRenderer.on('app-focus', h);
      return () => ipcRenderer.removeListener('app-focus', h);
    },
    /** Opens the connect window (server URL, API key, extra headers). */
    openServerSettings: () => ipcRenderer.send('open-connect'),
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
}
