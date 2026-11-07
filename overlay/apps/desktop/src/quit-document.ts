/** Inspect the application document before Host teardown without unloading its renderer. */
import type { WebContents } from 'electron'

/** A clean document, an explicit unload veto, or a renderer that could not answer. */
export type DesktopDocumentInspection = 'clean' | 'unsaved' | 'unavailable'

const INSPECTION_TIMEOUT_MS = 2000
const INSPECT_DOCUMENT = `(async () => {
  const pending = [];
  window.dispatchEvent(new CustomEvent('dsh:prepare-close', { detail: {
    waitUntil(operation) { pending.push(Promise.resolve(operation)); }
  } }));
  await Promise.all(pending);
  const event = new Event('beforeunload', { cancelable: true });
  const allowed = window.dispatchEvent(event);
  return !allowed || event.defaultPrevented;
})()`

/**
 * Await document checkpoints, then ask cancelable beforeunload listeners before stopping the Host.
 * @param contents - The application page; absent or destroyed means no live document.
 * @returns An explicit veto is unsaved; a failed, malformed, or late answer is unavailable.
 */
export async function inspectDesktopDocument(
  contents: Pick<WebContents, 'executeJavaScript' | 'isDestroyed'> | undefined,
): Promise<DesktopDocumentInspection> {
  if (contents === undefined || contents.isDestroyed()) return 'clean'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<'unavailable'>((resolve) => {
      timer = setTimeout(() => { resolve('unavailable') }, INSPECTION_TIMEOUT_MS)
    })
    const answer: unknown = await Promise.race([contents.executeJavaScript(INSPECT_DOCUMENT), timeout])
    if (contents.isDestroyed()) return 'unavailable'
    return answer === true ? 'unsaved' : answer === false ? 'clean' : 'unavailable'
  } catch (error) {
    console.warn('desktop quit: document inspection unavailable', error)
    return 'unavailable'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
