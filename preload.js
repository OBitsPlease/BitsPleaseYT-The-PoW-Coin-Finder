const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchCoins: () => ipcRenderer.invoke('fetch-coins'),
  fetchPowDirectory: () => ipcRenderer.invoke('fetch-pow-directory'),
  promptLogin: () => ipcRenderer.invoke('prompt-login'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
