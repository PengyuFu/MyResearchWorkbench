/**
 * MyResearchWorkbench Windows portable packaging entry.
 *
 * The build host has no Visual C++ Build Tools and no Windows SDK, so the
 * upstream guard sequence cannot run: it always performs a `vswhere` C++
 * probe before building and compiles the NSIS installer UI artwork through
 * electron-builder's `beforeBuild`. This entry reuses the upstream preparation
 * functions (`build:official`, release packing, `prepare:runtime`,
 * `prepare:packages`, `prepare:dsh`) and electron-builder itself, while
 * skipping only those two Windows installer prerequisites. It produces the
 * unsigned `win-unpacked` application directory instead of an installer.
 *
 * Run through pnpm so `npm_execpath` reaches the upstream pnpm child processes:
 *   pnpm exec tsx scripts/mrw/package-portable.ts
 * Public unsigned settings live in scripts/mrw/portable-settings.json; release credential files are not read.
 * Set MRW_PORTABLE_VERIFICATION=workbench for UI-only patches; run the targeted packaged-EXE acceptance separately.
 * Set MRW_PORTABLE_CHECK=1 to validate configuration and caches only.
 * Set MRW_STAGED_APP_DIR to an absolute, unused delivery directory.
 * Set DSH_DESKTOP_PACKAGE_CACHE_DIR to an absolute directory to reuse verified downloads and packages.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  desktopElectronBuilderArguments,
  desktopElectronBuilderEnvironment,
  parseDesktopPackageInvocation,
  resolveDesktopPackageTarget,
  withoutDesktopUploadCredentials,
  withoutWindowsSigningEnvironment,
} from '../../apps/desktop/scripts/package-target.ts'
import {
  validateDesktopPackageEnvironment,
} from '../../apps/desktop/scripts/desktop-package-environment.mjs'
import { desktopArtifactOutput, resolveDesktopTargetBuildPaths } from '../../apps/desktop/scripts/desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../../apps/desktop/src/runtime-tree.ts'
import { smokePreparedRuntime } from '../../apps/desktop/scripts/smoke-prepared-runtime.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')
const DESKTOP_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop')
const TARGET = 'win-x64'

/**
 * Load public, unsigned-portable settings without opening release credential files.
 * @param parent - Tool environment; release and signing values are removed before applying the public file.
 * @returns Isolated settings passed through the normal upstream validators and preparation functions.
 */
function loadPortableEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const input: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'scripts', 'mrw', 'portable-settings.json'), 'utf8'))
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('mrw package: public settings must be an object')
  const allowed = new Set([
    'DSH_DESKTOP_APP_ID', 'DSH_DESKTOP_AUTO_UPDATE_ENV', 'DSH_DESKTOP_NPM_REGISTRY',
    'DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG',
    'DOWNLOAD_TEST_ORIGIN', 'DOWNLOAD_TEST_RELEASE_ID',
  ])
  const settings: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(input)) {
    if (!allowed.has(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`mrw package: unsupported public setting ${name}`)
    }
    settings[name] = value
  }
  const releaseKeys = [
    /^(?:DSH_PACKAGING_.*|PACKAGE_TEST_RELEASE_ID|APPLE_.*|(?:WIN_)?CSC_.*|DOWNLOAD_(?:TEST|PROD)_.*)$/iu,
    /^DSH_DESKTOP_(?:APP_ID|AUTO_UPDATE_ENV|NPM_REGISTRY|UPDATE_CHANNEL|MANDATORY_UPDATE_.*|WINDOWS_.*|MACOS_.*)$/iu,
  ]
  return { ...Object.fromEntries(Object.entries(parent).filter(([name]) => !releaseKeys.some(pattern => pattern.test(name)))), ...settings }
}

interface PrimaryRuntimeLock {
  readonly targets: Readonly<Record<string, { readonly pythonSha256: string }>>
}

function lockPythonSha256(): string {
  const lock = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'scripts', 'primary-runtime', 'lock.json'), 'utf8')) as PrimaryRuntimeLock
  const target = lock.targets[TARGET]
  if (target === undefined) throw new Error(`mrw package: primary-runtime lock has no ${TARGET} target`)
  return target.pythonSha256
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Place the locked python-build-standalone archive in the hash-addressed cache.
 * `downloadPrimaryRuntimeAsset` reuses a cache hit after verifying its digest
 * and never contacts github.com for an already seeded file.
 */
function seedPrimaryRuntimeCache(): void {
  const digest = lockPythonSha256()
  const cache = resolveDesktopTargetBuildPaths(process.env).downloads
  mkdirSync(cache, { recursive: true })
  const destination = join(cache, digest)
  if (existsSync(destination)) {
    if (sha256(destination) !== digest) throw new Error(`mrw package: cached primary runtime archive does not match lock: ${destination}`)
    console.log(`mrw package: primary runtime archive already cached (${destination})`)
    return
  }
  const source = process.env.MRW_PRIMARY_RUNTIME_PYTHON_ARCHIVE
  if (source === undefined) {
    console.log('mrw package: no local Python archive specified; upstream will fetch and verify its pinned official release')
    return
  }
  if (!existsSync(source)) throw new Error(`mrw package: primary runtime archive not found at ${source}; use an officially verified archive`)
  if (sha256(source) !== digest) throw new Error(`mrw package: primary runtime archive does not match scripts/primary-runtime/lock.json: ${source}`)
  copyFileSync(source, destination)
  console.log(`mrw package: seeded primary runtime archive from ${source}`)
}

/**
 * Pack private `packages/<group>/<name>` workspace members into the release
 * directory. Upstream release packing skips `private: true` members, but a
 * private workspace package that the shipped Web bundle depends on must exist
 * in the local package set for `prepare:packages` to select it.
 * @param environment - Scrubbed build environment.
 * @param destination - Packed dsh tarball directory.
 */
function packPrivateRuntimeMembers(environment: NodeJS.ProcessEnv, destination: string): void {
  const packagesRoot = join(REPOSITORY_ROOT, 'packages')
  for (const group of readdirSync(packagesRoot)) {
    const groupPath = join(packagesRoot, group)
    if (!statSync(groupPath).isDirectory()) continue
    for (const name of readdirSync(groupPath)) {
      const directory = join(groupPath, name)
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { private?: boolean; name?: string }
      if (manifest.private !== true || manifest.name === undefined) continue
      const tarball = join(destination, `${manifest.name.replace(/^@/u, '').replace(/[/]/gu, '-')}-${
        (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version}.tgz`)
      if (existsSync(tarball)) continue
      runPnpm(['--dir', directory, 'pack', '--pack-destination', destination], environment, REPOSITORY_ROOT)
    }
  }
}

function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv, cwd: string): void {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined) throw new Error('mrw package: npm_execpath is undefined')
  console.log(`mrw package: pnpm ${args.join(' ')}`)
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], { cwd, env: environment, stdio: 'inherit', windowsHide: true })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`mrw package: pnpm ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`)
}

/**
 * Build official-profile artifacts and run the aggregate type checks before
 * packing. The portable route omits the installer-only Windows prerequisites;
 * runtime preparation and electron-builder use the upstream implementations.
 * Packaged-runtime smoke runs from the final delivery path to keep Python
 * extension paths below the Windows path-length limit.
 * @param invocation - Validated Windows portable packaging request.
 * @param environment - File-owned release settings.
 */
function runUpstreamPortableSequence(
  invocation: ReturnType<typeof parseDesktopPackageInvocation>,
  environment: NodeJS.ProcessEnv,
): void {
  const target = invocation.target
  const buildPaths = resolveDesktopTargetBuildPaths(environment)
  const buildEnv = withoutWindowsSigningEnvironment(withoutDesktopUploadCredentials(
    desktopElectronBuilderEnvironment(environment, invocation.unsigned)))
  const targetEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: '0',
    DSH_DESKTOP_TARGET_PLATFORM: target.platform,
    DSH_DESKTOP_TARGET_ARCH: target.arch,
  }
  const downloadEnv = targetEnv
  const electronBuilderEnv = desktopElectronBuilderEnvironment(downloadEnv, invocation.unsigned)
  runPnpm(['run', 'build:artifacts'], { ...buildEnv, DSH_BUILD_CLIENT_PROFILE: 'official' }, REPOSITORY_ROOT)
  runPnpm(['run', 'build:check'], buildEnv, REPOSITORY_ROOT)
  runPnpm(['run', 'release:pack', '--family', 'dsh', '--out', buildPaths.packedDsh], buildEnv, REPOSITORY_ROOT)
  packPrivateRuntimeMembers(buildEnv, buildPaths.packedDsh)
  runPnpm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', buildPaths.packedDsh], buildEnv, REPOSITORY_ROOT)
  runPnpm(['run', 'release:pack', '--family', 'vendor', '--out', buildPaths.packedVendor], buildEnv, REPOSITORY_ROOT)
  rmSync(buildPaths.packedLandlock, { recursive: true, force: true })
  mkdirSync(buildPaths.packedLandlock, { recursive: true })
  runPnpm(['--dir', 'native/system', 'run', 'build:ts'], buildEnv, REPOSITORY_ROOT)
  runPnpm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', buildPaths.packedLandlock], buildEnv, REPOSITORY_ROOT)
  runPnpm(['run', 'prepare:runtime', '--defer-primary-runtime-smoke'], downloadEnv, DESKTOP_ROOT)
  runPnpm(['run', 'prepare:packages'], targetEnv, DESKTOP_ROOT)
  runPnpm(['run', 'prepare:dsh', '--defer-primary-runtime-smoke', '--defer-runtime-smoke'], downloadEnv, DESKTOP_ROOT)
  runPnpm(desktopElectronBuilderArguments(target, true), electronBuilderEnv, DESKTOP_ROOT)
}

/**
 * Copy the built application to a short delivery path and run the upstream
 * packaged-runtime smoke there. The build output directory is deeper than the
 * Windows path limit the bundled Python lxml extension tolerates, while the
 * delivery path is not, so the smoke runs where the product will live.
 * @param invocation - Validated Windows portable packaging request.
 * @param environment - File-owned release settings.
 * @returns Absolute staged application directory.
 */
async function stageBuiltApplication(
  invocation: ReturnType<typeof parseDesktopPackageInvocation>,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const target = invocation.target
  const buildPaths = resolveDesktopTargetBuildPaths(environment)
  const artifacts = desktopArtifactOutput(buildPaths, { unsigned: true, skipNotarization: false }).directory
  const unpacked = join(artifacts, 'win-unpacked')
  if (!existsSync(join(unpacked, 'MyResearchWorkbench.exe'))) throw new Error(`mrw package: built application not found at ${unpacked}`)
  const stage = requireStageDirectory()
  if (process.env.MRW_STAGE_SKIP_COPY !== '1') {
    if (existsSync(stage)) throw new Error(`mrw package: delivery already exists: ${stage}`)
    mkdirSync(stage, { recursive: true })
    console.log(`mrw package: staging built application at ${stage}`)
    const copy = spawnSync('robocopy.exe', [unpacked, stage, '/E', '/MT:8', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/NJH', '/NJS'],
      { windowsHide: true, stdio: 'inherit' })
    if (copy.error !== undefined) throw copy.error
    if (copy.status === null || copy.status < 0 || copy.status >= 8) {
      throw new Error(`mrw package: Windows Robocopy staging failed with ${String(copy.status ?? copy.signal)}`)
    }
    if (!existsSync(join(stage, 'MyResearchWorkbench.exe'))) throw new Error('mrw package: staged executable is missing')
  } else {
    console.log(`mrw package: reusing staged application at ${stage}`)
  }
  const descriptor = await verifyDesktopRuntime(buildPaths.dsh, readDesktopRuntime(buildPaths.dsh).release.version,
    resolveDesktopPackageTarget(target.name))
  console.log(`mrw package: prepared descriptor release=${descriptor.release.version} files=${String(descriptor.files.length)}`)
  if (process.env.MRW_PORTABLE_VERIFICATION === 'workbench') {
    console.log('mrw package: runtime integrity verified; targeted packaged-EXE acceptance remains required')
  } else {
    await smokePreparedRuntime(join(stage, 'resources', 'app.asar', 'dsh'),
      join(stage, 'MyResearchWorkbench.exe'), join(stage, 'resources', 'runtime'), descriptor)
    console.log('mrw package: staged application smoke passed')
  }
  return stage
}

function writePortableRecord(extra: Readonly<Record<string, unknown>> = {}): void {
  const product = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { version: string }
  writeFileSync(join(DESKTOP_ROOT, '.desktop-build', 'targets', TARGET, 'mrw-portable-build.json'), `${JSON.stringify({
    product: 'MyResearchWorkbench',
    version: product.version,
    mode: 'unsigned-portable-dir',
    buildTimeUtc: new Date().toISOString(),
    deviations: [
      'toolchain precheck skipped: Visual C++ Build Tools and Windows SDK are unavailable on this host',
      'NSIS installer UI compilation skipped; portable win-unpacked directory instead of an installer',
      'unsigned build; code signing and SmartScreen behavior unverified',
      'update policy origins are explicit placeholders; no updater backend',
      'unsigned portable settings loaded from the checked-in public JSON; no release credential files read',
      'official-profile build:artifacts and build:check run as separate required gates before packing',
      'private packages/*/* runtime members packed explicitly because upstream release packing omits private members',
      process.env.MRW_PORTABLE_VERIFICATION === 'workbench'
        ? 'UI-only patch: runtime integrity verified; unrelated Office/plugin/runtime execution not repeated; targeted staged-EXE acceptance required separately'
        : 'packaged-runtime smoke run from the staged delivery path because the build output path exceeds the Windows path limit for bundled lxml',
    ],
    ...extra,
  }, undefined, 2)}\n`)
}

function requireStageDirectory(): string {
  const stage = process.env.MRW_STAGED_APP_DIR
  if (!stage || !isAbsolute(stage)) {
    throw new Error('mrw package: MRW_STAGED_APP_DIR must be an absolute output directory')
  }
  return stage
}

async function main(): Promise<void> {
  requireStageDirectory()
  if (process.env.npm_execpath === undefined) throw new Error('mrw package: run through pnpm so npm_execpath is defined')
  if (process.env.MRW_PORTABLE_VERIFICATION !== undefined && process.env.MRW_PORTABLE_VERIFICATION !== 'workbench') {
    throw new Error('mrw package: MRW_PORTABLE_VERIFICATION must be unset or workbench')
  }
  process.env.MRW_PORTABLE_PACKAGE = '1'
  process.env.ELECTRON_MIRROR ??= 'https://cdn.npmmirror.com/binaries/electron/'
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/'
  seedPrimaryRuntimeCache()
  const invocation = parseDesktopPackageInvocation([TARGET, '--unsigned', '--dir'])
  const environment = loadPortableEnvironment(process.env)
  validateDesktopPackageEnvironment(environment, invocation.target, invocation)
  console.log('mrw package: configuration and runtime cache valid')
  if (process.env.MRW_PORTABLE_CHECK === '1') {
    console.log('mrw package: check mode finished without building')
    return
  }
  console.log('mrw package: starting upstream portable packaging sequence')
  if (process.env.MRW_STAGE_ONLY === '1') {
    const stage = await stageBuiltApplication(invocation, environment)
    writePortableRecord({ stagedApplication: stage, stageOnly: true })
    console.log('mrw package: stage-only finished')
    return
  }
  runUpstreamPortableSequence(invocation, environment)
  const stage = await stageBuiltApplication(invocation, environment)
  writePortableRecord({ stagedApplication: stage })
  console.log('mrw package: portable packaged application ready')
}

await main()
