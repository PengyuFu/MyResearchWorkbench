import { mkdirSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

interface DesktopDataApp {
  getPath(name: 'appData'): string
  getVersion(): string
  setPath(name: 'userData' | 'sessionData', path: string): void
}

/** Keep each installed MRW version, its renderer state, and its Host profile separate. */
export function configureMrwDataRoots(app: DesktopDataApp, environment: NodeJS.ProcessEnv): {
  version: string
  userData: string
  home: string
} {
  const version = app.getVersion()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('MyResearchWorkbench data roots require a semantic application package version')
  }
  const configured = (name: 'MRW_DSH_HOME' | 'MRW_ELECTRON_USER_DATA'): string | undefined => {
    const value = environment[name]?.trim() ?? ''
    if (value === '') return undefined
    if (!isAbsolute(value)) throw new Error(name + ' must be an absolute path')
    return normalize(value)
  }
  const appData = app.getPath('appData')
  const userData = configured('MRW_ELECTRON_USER_DATA')
    ?? join(appData, 'MyResearchWorkbench', version, 'electron')
  const home = configured('MRW_DSH_HOME')
    ?? join(environment.LOCALAPPDATA?.trim() || appData, 'MyResearchWorkbench', version, 'home')

  // Electron requires overridden directories to exist before ready. Set both
  // paths explicitly so localStorage/IndexedDB never use another trial's cache.
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  environment.DSH_HOME = home
  return { version, userData, home }
}
