/// <reference types="vite/client" />

declare global {
  interface Window {
    electronAPI: {
      saveChartFile: (payload: {
        filePath?: string
        suggestedName?: string
        content: string
      }) => Promise<{
        success: boolean
        canceled?: boolean
        filePath?: string
        error?: string
      }>
      printChartToPdf: (payload: {
        html: string
        title: string
        assets: Array<{ name: string, bytes: Uint8Array }>
      }) => Promise<{
        success: boolean
        canceled?: boolean
        filePath?: string
        error?: string
      }>
    }
  }
}

export {}
