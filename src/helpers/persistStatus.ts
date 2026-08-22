// Whether the app is still able to save, and whether it is the only window
// doing so.
//
// Deliberately NOT part of the Pinia store. The autosave in
// `LocalStorageWatcher` runs inside `store.$subscribe`, so writing a failure
// flag back into the store would re-enter the subscription, reschedule the
// debounce, and turn a failing write into a permanent 300ms retry loop. A plain
// ref is observed by the components that display it and by nothing else.

import { ref } from 'vue'

// Set while autosave is failing, cleared by the next write that succeeds. The
// user has to be able to see this for as long as it is true: a single alert
// that never comes back leaves them editing an app that stopped persisting.
export const persistError = ref<string | null>(null)

// Set when another window of the app is live on the same storage. Both windows
// write the whole chart map, so the last one to write wins.
export const multipleWindowsOpen = ref(false)

export function reportPersistFailure(message: string): void {
  persistError.value = message
}

export function reportPersistSuccess(): void {
  persistError.value = null
}

const PRESENCE_CHANNEL = 'thoughtslibrary-presence'
const PRESENCE_REPLY_MS = 300

/**
 * Asks whether any other window of the app is already running, and keeps
 * answering that question for the windows that ask later.
 *
 * Resolves true when another window answered within the window below. A false
 * answer is not a proof of solitude - a window that opens a millisecond later
 * cannot be seen - but it is enough to keep the startup asset sweep from
 * running while a second window holds references it cannot see.
 */
export function detectOtherWindows(): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    let channel: BroadcastChannel

    try {
      channel = new BroadcastChannel(PRESENCE_CHANNEL)
    }
    catch {
      resolve(false)
      return
    }

    let settled = false
    const finish = (answer: boolean) => {
      if (settled) {
        return
      }
      settled = true
      multipleWindowsOpen.value = answer
      resolve(answer)
    }

    channel.onmessage = (event) => {
      // Another window announcing itself after we started: answer it, and note
      // that we are no longer alone even though our own probe already resolved.
      if (event.data === 'who-is-there') {
        channel.postMessage('here')
        multipleWindowsOpen.value = true
        return
      }

      if (event.data === 'here') {
        finish(true)
      }
    }

    channel.postMessage('who-is-there')
    setTimeout(() => finish(false), PRESENCE_REPLY_MS)
  })
}
