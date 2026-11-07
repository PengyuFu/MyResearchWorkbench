/** Ordinary release entry; qualification imports the environment-independent factory. */
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'

export { createElectronBuilderConfig }

/**
 * MyResearchWorkbench formal portable packaging.
 *
 * The build host has no Visual C++ Build Tools or Windows SDK, so the NSIS
 * installer artwork helper cannot compile. This mode keeps electron-builder's
 * production dependency collection (`beforeBuild` resolving to true) while
 * skipping only the installer UI compilation; the caller builds a `--dir`
 * artifacts directory instead of an installer.
 * @returns electron-builder configuration for this entry point.
 */
function desktopPackageConfig() {
  const config = createElectronBuilderConfig()
  if (process.env.MRW_PORTABLE_PACKAGE !== '1') return config
  return { ...config, extraMetadata: { ...config.extraMetadata, dshDesktopUpdateChannel: 'latest' }, beforeBuild: async () => true }
}

export default desktopPackageConfig()
