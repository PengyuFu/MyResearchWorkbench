#Requires -Version 5.1
# Assemble a source checkout from official upstream + approved overlay + separate release assets.
# Runs only in an explicitly new destination. No proxy, registry, user profile or stable install is changed.
param(
    [Parameter(Mandatory = $true)][string]$AssetsDir,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$lock = Get-Content -LiteralPath (Join-Path $source 'SOURCES.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $source 'OVERLAY.manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$assets = (Resolve-Path -LiteralPath $AssetsDir).Path
$target = [IO.Path]::GetFullPath($Destination)

if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This tested assembly procedure targets Windows x64 only.'
}
if (Test-Path -LiteralPath $target) {
    throw 'Destination already exists. Choose a new, empty checkout path.'
}
function Assert-Asset([string]$name, [string]$expectedSha) {
    $file = Join-Path $assets $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing approved release asset: $name" }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expectedSha) { throw "SHA-256 mismatch: $name" }
    return $file
}
$docx = Assert-Asset $lock.docx.compiledArtifact $lock.docx.compiledSha256
$runtime = Assert-Asset $lock.proprietaryRuntime.file $lock.proprietaryRuntime.sha256
$eula = Assert-Asset $lock.licensePolicy.privateRuntimeEulaFile $lock.licensePolicy.privateRuntimeEulaSha256
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
    throw 'Corepack is required with Node.js 24 to invoke the pinned pnpm version.'
}
Push-Location (Join-Path $source 'overlay')
$previousNativeWarningPolicy = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $resolvedPnpmVersion = (& corepack pnpm --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Corepack failed to resolve pnpm.' }
} finally {
    $ErrorActionPreference = $previousNativeWarningPolicy
    Pop-Location
}
if ($resolvedPnpmVersion -ne $lock.toolchain.pnpm) {
    throw 'Corepack must resolve the pinned pnpm version before building.'
}
$patch = Join-Path $source $lock.docx.sourcePatch
if ((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.docx.sourcePatchSha256) {
    throw 'DOCX source patch does not match SOURCES.lock.json.'
}

$previousNativeWarningPolicy = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    & git -c http.version=HTTP/1.1 clone --depth 1 --branch $lock.harness.tag -- $lock.harness.repository $target
    $gitExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousNativeWarningPolicy
}
if ($gitExitCode -ne 0) { throw 'Failed to clone official DeepSeek Harness.' }
$checkout = (& git -C $target rev-parse HEAD).Trim()
$tree = (& git -C $target show -s --format=%T HEAD).Trim()
if ($checkout -ne $lock.harness.commit -or $tree -ne $lock.harness.tree) {
    throw 'Official Harness commit/tree identity does not match SOURCES.lock.json.'
}

foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    $inputFile = Join-Path (Join-Path $source 'overlay') ($relative -replace '/', '\')
    $hash = (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.sha256) { throw "Overlay file hash mismatch: $relative" }
    $outputFile = Join-Path $target ($relative -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $outputFile) -Force | Out-Null
    Copy-Item -LiteralPath $inputFile -Destination $outputFile -Force
}
foreach ($legalFile in @('LICENSE-MYRESEARCHWORKBENCH-NC.md', 'LICENSE.en.md', 'LICENSE-SCOPE.md', 'LICENSE-SCOPE.en.md')) {
    Copy-Item -LiteralPath (Join-Path $source $legalFile) -Destination (Join-Path $target $legalFile) -Force
}
Copy-Item -LiteralPath $docx -Destination (Join-Path $target 'third_party/docx-editor')

$previousMode = [Environment]::GetEnvironmentVariable('MRW_BUILD_MODE', 'Process')
$previousArchive = [Environment]::GetEnvironmentVariable('MRW_PUBLIC_RUNTIME_TGZ', 'Process')
$previousStage = [Environment]::GetEnvironmentVariable('MRW_STAGED_APP_DIR', 'Process')
$previousNodeProxy = [Environment]::GetEnvironmentVariable('NODE_USE_ENV_PROXY', 'Process')
$previousElectronProxy = [Environment]::GetEnvironmentVariable('ELECTRON_GET_USE_PROXY', 'Process')
$previousNoProxy = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
try {
    $env:MRW_BUILD_MODE = 'public'
    $env:MRW_PUBLIC_RUNTIME_TGZ = $runtime
    if ($env:HTTPS_PROXY -or $env:HTTP_PROXY) {
        $env:NODE_USE_ENV_PROXY = '1'
        $env:ELECTRON_GET_USE_PROXY = 'true'
        $env:NO_PROXY = (@($previousNoProxy, 'localhost,127.0.0.1,::1') | Where-Object { $_ }) -join ','
    }
    $env:MRW_STAGED_APP_DIR = Join-Path $target ('MyResearchWorkbench-' + $lock.applicationPackageVersion)
    Push-Location $target
    $previousNativeWarningPolicy = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & corepack pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & corepack pnpm exec tsx scripts/mrw/package-portable.ts
        if ($LASTEXITCODE -ne 0) { throw 'Windows unsigned portable directory build failed.' }
    } finally {
        $ErrorActionPreference = $previousNativeWarningPolicy
        Pop-Location
    }
} finally {
    [Environment]::SetEnvironmentVariable('MRW_BUILD_MODE', $previousMode, 'Process')
    [Environment]::SetEnvironmentVariable('MRW_PUBLIC_RUNTIME_TGZ', $previousArchive, 'Process')
    [Environment]::SetEnvironmentVariable('MRW_STAGED_APP_DIR', $previousStage, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_USE_ENV_PROXY', $previousNodeProxy, 'Process')
    [Environment]::SetEnvironmentVariable('ELECTRON_GET_USE_PROXY', $previousElectronProxy, 'Process')
    [Environment]::SetEnvironmentVariable('NO_PROXY', $previousNoProxy, 'Process')
}
$appDir = Join-Path $target ('MyResearchWorkbench-' + $lock.applicationPackageVersion)
if (!(Test-Path -LiteralPath (Join-Path $appDir 'MyResearchWorkbench.exe') -PathType Leaf)) {
    throw 'Windows application executable missing after the build.'
}
$licenseDir = Join-Path $appDir 'licenses'
New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
Copy-Item -Path (Join-Path $source 'LICENSES/*') -Destination $licenseDir -Recurse -Force
foreach ($license in @('LICENSE-MYRESEARCHWORKBENCH-NC.md', 'LICENSE.en.md', 'LICENSE-SCOPE.md', 'LICENSE-SCOPE.en.md')) {
    Copy-Item -LiteralPath (Join-Path $source $license) -Destination (Join-Path $licenseDir $license) -Force
}
Copy-Item -LiteralPath $eula -Destination (Join-Path $licenseDir $lock.licensePolicy.privateRuntimeEulaFile) -Force
foreach ($required in @('THIRD_PARTY_SOURCE_AVAILABILITY.md', 'THIRD_PARTY_ORIGINALS/GNU-LGPL-3.0.txt', 'LICENSE-SCOPE.md', $lock.licensePolicy.privateRuntimeEulaFile)) {
    if (!(Test-Path -LiteralPath (Join-Path $licenseDir $required) -PathType Leaf)) {
        throw ("Required final distribution license file is missing: " + $required)
    }
}
foreach ($guide in @('README_WINDOWS.md', 'README_WINDOWS.en.md', 'THIRD_PARTY_SOURCE_ACCESS.md', 'THIRD_PARTY_SOURCE_ACCESS.en.md')) {
    Copy-Item -LiteralPath (Join-Path $source $guide) -Destination (Join-Path $appDir $guide) -Force
}
Write-Output ('Built application: ' + $appDir)
