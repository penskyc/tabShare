// Screen-share picker window (picker.html): receives the capturable sources, sends back the chosen id (or null).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (cb) => ipcRenderer.once('sources', (_e, sources) => cb(sources)),
  choose: (id) => ipcRenderer.send('picker-choice', id),
});
