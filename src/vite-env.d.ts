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
        widthPixels: number
        heightPixels: number
        title: string
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
