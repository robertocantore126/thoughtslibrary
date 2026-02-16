const configuredBackend = import.meta.env.VITE_BACKEND_URL?.trim()

export const backendBaseUrl = configuredBackend || (import.meta.env.DEV ? '' : 'https://api.topsters.org')
