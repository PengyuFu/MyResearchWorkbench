/**
 * Local Electron shell settings, loaded once per process independently of the Host.
 * Ownership: .agents/notes/implemented/architecture/2026-10-08-desktop-shell-configuration.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Persisted rectangle of one auxiliary shell window, in screen device-independent pixels. */
export interface DesktopWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Resolved shell preferences; absent fields use the defaults without rewriting existing files. */
export interface DesktopSettings {
  readonly updates: {
    readonly allowTestAuthPopupWindow: boolean
  }
  /** Last valid rectangle of the floating plan window, or null before it was first placed. */
  readonly planWindow: DesktopWindowBounds | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one persisted window rectangle.
 * @param value - stored value.
 * @returns the rectangle, or null when it is absent or not four finite integers.
 */
function windowBounds(value: unknown): DesktopWindowBounds | null {
  if (!record(value)) return null
  const values = [value.x, value.y, value.width, value.height]
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item))) return null
  const x = value.x as number
  const y = value.y as number
  const width = value.width as number
  const height = value.height as number
  if (width < 1 || height < 1) return null
  return { x, y, width, height }
}

/**
 * Read shell settings, creating the default document exclusively when missing.
 * @param userData - Electron's userData directory, independent of DSH_HOME.
 * @returns Validated settings, or defaults when reading, creating or validating fails; changes require a restart.
 */
export function readDesktopSettings(userData: string): DesktopSettings {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  const defaults: DesktopSettings = { updates: { allowTestAuthPopupWindow: false }, planWindow: null }
  try {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch (error) {
        // An existing document belongs to the user, including one created during initialization.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      raw = readFileSync(path, 'utf8')
    }
    const value: unknown = JSON.parse(raw)
    if (!record(value) || (value.updates !== undefined && !record(value.updates))) {
      throw new Error('expected a JSON object with an optional updates object')
    }
    const allow = value.updates?.allowTestAuthPopupWindow
    if (allow !== undefined && typeof allow !== 'boolean') {
      throw new Error('updates.allowTestAuthPopupWindow must be true or false')
    }
    return {
      updates: { allowTestAuthPopupWindow: allow ?? false },
      planWindow: windowBounds(value.planWindow),
    }
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: using defaults because settings could not be loaded`, error)
    } catch (_logError) {
      // Diagnostic output is best effort; its failure must not make optional settings fatal.
      // TODO: Persist settings diagnostics when console output is unavailable, without blocking startup.
    }
    return defaults
  }
}

/**
 * Persist the floating plan window rectangle, keeping every other setting.
 *
 * A trailing write wins: the shell writes this only when the window stops moving
 * or resizing, so the stored rectangle is the one the user left behind.
 * @param userData - Electron's userData directory.
 * @param bounds - rectangle to remember, or null to clear it.
 */
export function writeDesktopPlanWindowBounds(userData: string, bounds: DesktopWindowBounds | null): void {
  const directory = join(userData, 'desktop')
  const path = join(directory, 'settings.json')
  try {
    let value: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (record(parsed)) value = parsed
    } catch (error) {
      // A missing or unreadable document is replaced by a complete one below.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    value.planWindow = bounds
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    try {
      console.warn(`desktop settings: ${path}: could not store the plan window rectangle`, error)
    } catch (_logError) {
      // Best-effort diagnostics only; a window rectangle is not worth failing the shell.
    }
  }
}
