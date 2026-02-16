import type { LastfmChartResponseItem, LastfmDataType, Period } from '../types'
import { backendBaseUrl } from './config'
import { errorMessages } from './errors'

async function queryLastFM(query: string): Promise<unknown[]> {
  if (query === '') {
    return []
  }

  const encodedQuery = encodeURIComponent(query)

  const res = await fetch(`${backendBaseUrl}/api/lastfm/search/${encodedQuery}`)

  if (!res) {
    throw new Error(errorMessages.NoConnection)
  }

  if (res.status !== 200) {
    throw new Error(errorMessages.BadStatusCode)
  }

  const jsonRes = await res.json()
  if (jsonRes.error) {
    throw new Error(jsonRes.message || 'Last.fm API error')
  }

  const albums = jsonRes?.results?.albummatches?.album

  if (!albums) {
    return []
  }

  if (!Array.isArray(albums)) {
    return [albums]
  }

  return albums
}

export async function getLastfmChart(username: string, type: LastfmDataType, period?: Period): Promise<LastfmChartResponseItem[]> {
  if (username === '') {
    return []
  }

  const res = await fetch(
    `${backendBaseUrl}/api/lastfm/user/top?${new URLSearchParams({
      user: encodeURIComponent(username),
      type,
      period: period ? encodeURIComponent(period) : '',
    })}`,
  )

  if (!res) {
    throw new Error(errorMessages.NoConnection)
  }

  if (res.status !== 200) {
    throw new Error(errorMessages.BadStatusCode)
  }

  return await res.json()
}

export default queryLastFM
