const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  saveChartFile: payload => ipcRenderer.invoke('save-chart-file', payload),
  printChartToPdf: payload => ipcRenderer.invoke('print-chart-to-pdf', payload),
})
