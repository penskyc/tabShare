// Connect window (connect.html): server URL, API key and extra headers, tested and saved by main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connect', {
  load: () => ipcRenderer.invoke('connect-load'),
  test: (s) => ipcRenderer.invoke('connect-test', s),
  save: (s) => ipcRenderer.invoke('connect-save', s),
});
