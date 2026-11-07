import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureMrwDataRoots } from '../src/mrw-data-roots.ts'

let temporary: string
beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), 'mrw-desktop-roots-')) })
afterEach(() => { rmSync(temporary, { recursive: true, force: true }) })

function application(version = '0.5.0') {
  const paths: Partial<Record<'userData' | 'sessionData', string>> = {}
  const appData = join(temporary, 'Roaming data with spaces')
  return {
    paths, appData,
    app: {
      getVersion: () => version,
      getPath: (_name: 'appData') => appData,
      setPath: (name: 'userData' | 'sessionData', value: string) => {
        expect(existsSync(value)).toBe(true)
        paths[name] = value
      },
    },
  }
}

it('uses the installed 0.5.0 package version and leaves 0.4.0 data untouched', () => {
  const fixture = application()
  const local = join(temporary, 'Local data with spaces')
  const protectedFile = join(fixture.appData, 'MyResearchWorkbench', '0.4.0', 'electron', 'previous-data')
  mkdirSync(join(protectedFile, '..'), { recursive: true })
  writeFileSync(protectedFile, 'protected 0.4.0 data')
  const environment = { LOCALAPPDATA: local, DSH_HOME: join(temporary, 'inherited unrelated home') }
  const result = configureMrwDataRoots(fixture.app, environment)
  expect(result).toEqual({
    version: '0.5.0',
    userData: join(fixture.appData, 'MyResearchWorkbench', '0.5.0', 'electron'),
    home: join(local, 'MyResearchWorkbench', '0.5.0', 'home'),
  })
  expect(fixture.paths).toEqual({ userData: result.userData, sessionData: result.userData })
  expect(environment.DSH_HOME).toBe(result.home)
  expect(readFileSync(protectedFile, 'utf8')).toBe('protected 0.4.0 data')
  expect(existsSync(result.home)).toBe(false)
})

it('follows future package versions without source constants', () => {
  const fixture = application('0.6.1-beta.2')
  const result = configureMrwDataRoots(fixture.app, {})
  expect(result.userData).toBe(join(fixture.appData, 'MyResearchWorkbench', '0.6.1-beta.2', 'electron'))
  expect(result.home).toBe(join(fixture.appData, 'MyResearchWorkbench', '0.6.1-beta.2', 'home'))
})

it('keeps the two explicit absolute overrides independent and preserves spaces', () => {
  const fixture = application()
  const electron = join(temporary, 'owned Electron profile')
  const host = join(temporary, 'owned Host home')
  const environment = { MRW_ELECTRON_USER_DATA: '  ' + electron + '  ', MRW_DSH_HOME: host, DSH_HOME: 'ignored' }
  const result = configureMrwDataRoots(fixture.app, environment)
  expect(result.userData).toBe(electron)
  expect(result.home).toBe(host)
  expect(fixture.paths.sessionData).toBe(electron)
  expect(environment.DSH_HOME).toBe(host)
  expect(existsSync(join(fixture.appData, 'MyResearchWorkbench'))).toBe(false)
})

it.each(['MRW_DSH_HOME', 'MRW_ELECTRON_USER_DATA'] as const)('rejects relative %s before touching any data directory', (name) => {
  const fixture = application()
  expect(() => configureMrwDataRoots(fixture.app, { [name]: 'relative test directory' })).toThrow(name + ' must be an absolute path')
  expect(fixture.paths).toEqual({})
  expect(existsSync(fixture.appData)).toBe(false)
})

it('ignores empty overrides and does not duplicate the version when LOCALAPPDATA is absent', () => {
  const fixture = application()
  const result = configureMrwDataRoots(fixture.app, { MRW_DSH_HOME: ' ', MRW_ELECTRON_USER_DATA: '', LOCALAPPDATA: ' ' })
  expect(result.home).toBe(join(fixture.appData, 'MyResearchWorkbench', '0.5.0', 'home'))
})

it('rejects an invalid package version before creating renderer storage', () => {
  const fixture = application('../0.4.0')
  expect(() => configureMrwDataRoots(fixture.app, {})).toThrow('semantic application package version')
  expect(existsSync(fixture.appData)).toBe(false)
})
