import { backendBaseUrl } from './config'

async function fetchImageURL(url: string): Promise<string> {
  let blob: Blob

  // If the origin site has CORS * headers, we're all set!
  // Otherwise we need to go through our CORS proxy.
  try {
    const directData = await fetch(url)
    blob = await directData.blob()
  }
  catch (e) {
    // eslint-disable-next-line no-console
    console.log(e)
    const proxyURL = `${backendBaseUrl}/api/proxy`
    const proxyData = await fetch(proxyURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
      }),
    })

    blob = await proxyData.blob()
  }

  return URL.createObjectURL(blob)
}

export default fetchImageURL
