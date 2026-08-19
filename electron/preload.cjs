const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  saveChartFile: payload => ipcRenderer.invoke('save-chart-file', payload),
  readChartFile: filePath => ipcRenderer.invoke('read-chart-file', filePath),
  printChartToPdf: payload => ipcRenderer.invoke('print-chart-to-pdf', payload),
  getPathForFile: file => webUtils.getPathForFile(file),
})
