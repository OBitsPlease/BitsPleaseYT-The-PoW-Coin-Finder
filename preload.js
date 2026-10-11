const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  fetchCoins: () => ipcRenderer.invoke('fetch-coins'),
  fetchPowDirectory: () => ipcRenderer.invoke('fetch-pow-directory'),
  promptLogin: () => ipcRenderer.invoke('prompt-login'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fetchWtmProfitability: (algoInputs) => ipcRenderer.invoke('fetch-wtm-profitability', algoInputs),
  fetchMinerCalcCoins: () => ipcRenderer.invoke('fetch-miner-calc-coins'),
  fetchWtmGpus: () => ipcRenderer.invoke('fetch-wtm-gpus'),
  fetchWtmGpuBenchmarks: (gpuId) => ipcRenderer.invoke('fetch-wtm-gpu-benchmarks', gpuId),
  fetchCustomCoinProfitability: (entries) => ipcRenderer.invoke('fetch-custom-coin-profitability', entries),
  fetchCalendar: () => ipcRenderer.invoke('fetch-calendar')
});
