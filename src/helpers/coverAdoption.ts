import type { Chart, ChartItem } from '../types'
import { adoptRemoteImage, isRemoteHttpUrl } from './assets'

/**
 * Copies remote cover and attachment images into the local asset store, so a
 * chart stops depending on the servers it imported them from.
 *
 * This runs *after* the app has rendered, never before it. The startup path
 * already awaits `persistChartAssets` and the orphan sweep behind a gate that
 * holds the whole UI back, and a chart with a few hundred covers would sit
 * there fetching every one of them before drawing anything.
 *
 * The work is deliberately slow. Fetching every cover at once is what makes
 * covers.openlibrary.org reject them in the first place, so a small number are
 * in flight at a time with a pause between batches. Nothing waits on this: an
 * image that has not been adopted yet still displays from its remote URL.
 */

// Small enough to stay far under any host's burst limit, large enough that a
// chart of a few hundred covers finishes within a minute or so.
const BATCH_SIZE = 3
const BATCH_PAUSE_MS = 350

export interface AdoptableAsset {
  itemId: string
  field: 'coverURL' | 'attachmentURL'
  url: string
}

// Every remote image the chart still points at, across the grid and every
// related layer. `items` is skipped: it is derived from `coordinates` and holds
// the same objects, so walking both would queue each cover twice.
export function collectAdoptableAssets(chart: Chart): AdoptableAsset[] {
  const found: AdoptableAsset[] = []
  const seen = new Set<string>()

  const visit = (item?: ChartItem | null) => {
    if (!item || seen.has(item.id)) {
      return
    }
    seen.add(item.id)

    for (const field of ['coverURL', 'attachmentURL'] as const) {
      const url = item[field]
      // App-relative covers like /thought_tile.svg are served by the app
      // itself and depend on nothing external, so they are left alone.
      if (isRemoteHttpUrl(url)) {
        found.push({ itemId: item.id, field, url: url as string })
      }
    }
  }

  Object.values(chart.coordinates || {}).forEach(visit)
  Object.values(chart.relatedLayers || {}).forEach(layer => Object.values(layer).forEach(visit))

  return found
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Adopts each asset in turn, reporting successes one at a time through
 * `onAdopted` rather than in a single batch at the end — a chart left open
 * should visibly stop depending on the network as it goes, and a run
 * interrupted by a closed tab still keeps whatever it had finished.
 *
 * `shouldStop` is checked between batches so a chart switch abandons the run
 * instead of writing one chart's covers onto another.
 */
export async function adoptChartCovers(
  assets: AdoptableAsset[],
  onAdopted: (asset: AdoptableAsset, localUrl: string) => void,
  shouldStop: () => boolean = () => false,
): Promise<number> {
  let adopted = 0

  for (let i = 0; i < assets.length; i += BATCH_SIZE) {
    if (shouldStop()) {
      return adopted
    }

    const batch = assets.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async asset => [asset, await adoptRemoteImage(asset.url)] as const),
    )

    if (shouldStop()) {
      return adopted
    }

    for (const [asset, localUrl] of results) {
      if (localUrl) {
        onAdopted(asset, localUrl)
        adopted += 1
      }
    }

    if (i + BATCH_SIZE < assets.length) {
      await pause(BATCH_PAUSE_MS)
    }
  }

  return adopted
}
