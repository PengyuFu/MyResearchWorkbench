# MyResearchWorkbench 0.12.0 — Windows x64

[简体中文](README_WINDOWS.md) | English

## Obtain, verify, and run

1. Download `MyResearchWorkbench_0.12.0_Windows_x64.zip` and `SHA256SUMS.txt` from the [official v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0). The corresponding third-party source archive is provided on the same page.
2. Run the command below in PowerShell and compare the result with the checksum listed for that exact file. If it differs, obtain the file again and do not run it.
3. Extract the entire ZIP into a new writable directory. Preserve every file and subdirectory.
4. Start `MyResearchWorkbench.exe`, select a workspace, and configure your model/API service as needed.

```powershell
Get-FileHash -Algorithm SHA256 .\MyResearchWorkbench_0.12.0_Windows_x64.zip
```

The complete package includes its required Node and Python runtimes. Keep the directory intact; do not move the EXE by itself. If an external tool reports a path-length error, use a shorter extraction directory. This is an unsigned portable application. If Windows displays a publisher warning, verify the official source and checksum and keep system security protections enabled.

## Feature dependencies

- Local plans, workspace files, and code editing do not require an API to be configured first.
- AI conversations and assistance require a working model endpoint. Connectivity, quotas, and charges depend on the service you choose.
- LaTeX compilation requires a suitable TeX installation. Other features that do not depend on TeX remain available without it.
- Word documents use the embedded DOCX editor. This release does not provide a native Word/WPS OLE host.
- PDF viewing/proofing in the writing workflow is included. Later releases' separate PDF board and literature workflows are outside this release.

## User data, restarts, and upgrades

Keep research documents and project workspaces in your own directories outside the extracted application. The default 0.12.0 state and configuration locations are:

- `%APPDATA%\MyResearchWorkbench\0.12.0\electron`
- `%LOCALAPPDATA%\MyResearchWorkbench\0.12.0\home`

Use the same Windows account and profile for ordinary restarts and when moving the same application version. Explicit profile arguments or custom environment settings may change these locations; preserve those settings too.

Before upgrading, close the application and back up your workspace and both user-data directories. Extract the new version separately and follow its migration instructions. Keep the old profile and application until you have confirmed that your projects and state are restored. Do not delete profiles or clear data as a way to recover missing projects.

**Cross-version recovery compatibility is to be provided by a subsequent release. Version 0.12.0 does not implement or promise automatic cross-version migration.** Updates are manual; no automatic update service is connected. Normal restart evidence does not establish cross-version migration behavior.

## Licensing, source, and privacy

The `licenses/` directory contains the original-code license, proprietary runtime EULA, and original third-party notices. See `THIRD_PARTY_SOURCE_ACCESS.en.md` and the corresponding source archive for source access and native-library replacement instructions. Third-party rights remain independent of the original-code noncommercial restrictions.

When you use an external model API, information needed for the task may be sent to the service you configured. Remove API keys, account details, and private document paths before sharing diagnostic logs.

Source: https://github.com/PengyuFu/MyResearchWorkbench

Licensing contact: fpy19941225@163.com.
