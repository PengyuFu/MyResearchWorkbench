/** Window-owned workspace directory dialogs for the local Desktop renderer. */

import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * Install the application-lifetime directory picker IPC handler.
 * @param getWindows - Every local application window; the dialog belongs to the
 * window that asked, and shell pages and subframes cannot open dialogs.
 */
export function installDesktopDirectoryPicker(getWindows: () => readonly (BrowserWindow | undefined)[]): void {
  const pending = new WeakMap<BrowserWindow, Promise<string | null>>()
  ipcMain.handle(DESKTOP_IPC.directoryPick, async (event) => {
    const window = getWindows().find((candidate): candidate is BrowserWindow => candidate !== undefined
      && !candidate.isDestroyed()
      && event.sender === candidate.webContents
      && event.senderFrame === candidate.webContents.mainFrame)
    if (window === undefined) throw new Error('dsh desktop: rejected directory picker from an unowned renderer')
    assertDesktopSender(event, ['app'])
    const existing = pending.get(window)
    if (existing !== undefined) return existing
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const result = dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }).then(
      ({ canceled, filePaths }) => window.isDestroyed() || canceled ? null : filePaths[0] ?? null,
    ).finally(() => { pending.delete(window) })
    pending.set(window, result)
    return result
  })
}
