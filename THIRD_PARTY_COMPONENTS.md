# Third-party components and license boundaries

This source overlay is not a substitute for the license and notice files in the corresponding upstream projects or the actual application distribution.

| Component | Pinned source | License / obligation to check | Distribution form |
| --- | --- | --- | --- |
| DeepSeek Harness | [Official repository](https://github.com/deepseek-ai/deepseek-harness), `dsh-v0.2.2-rc.1` | MIT; retain upstream notices and attribution | Retrieved directly by the builder; source is not copied into this repository |
| EigenPal DOCX Editor **Core** | [Official repository](https://github.com/eigenpal/docx-editor), commit `3cc7bf5d38510940d6e88ffcec4ecff82fd6333e` | Apache-2.0; preserve source copyright, license, modification notices and applicable NOTICE | Download original source; apply the textual `mrw.5` patch; or install separately approved Core package |
| HarfBuzzJS | [npm package](https://www.npmjs.com/package/harfbuzzjs), `1.6.1` | MIT; preserve its license and modification statement | Official npm download for patch reproduction; unchanged WASM and license are not included in this repository |
| Electron / Chromium | Versions recorded in the upstream build and `SOURCES.lock.json` | Electron and Chromium third-party license files as shipped | Downloaded by the upstream packaging process |
| Tiptap, CodeMirror, MathLive | Exact versions in the overlay dependency lockfile | Keep the original component license and bundled asset notices | Installed through pinned package manifests |
| LibreOffice Kit (native/Windows) | `@deepseek-ai/libreoffice-kit` and Windows payload, `0.1.5` | MPL-2.0; confirm applicable source/modification availability and notices for redistributed binaries | Original upstream/runtime dependency, subject to release audit |
| Sharp Windows binary | `@img/sharp-win32-x64` `0.35.5` | Manifest declares Apache-2.0 AND LGPL-3.0-or-later; examine actual binary components and applicable redistribution conditions | Installed by upstream package dependency closure |
| Standard Webhooks JavaScript `standardwebhooks@1.1.1` | [Official source](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript) | MIT for the npm library (`libraries/LICENSE`, copyright Svix); the separate protocol specification identifies Apache-2.0 | Pinned npm dependency; MIT text in `LICENSES/THIRD_PARTY_ORIGINALS/StandardWebhooks-MIT.txt` |
| Windows Python bridge and Python runtime | Versions pinned in the upstream project | Retain each bundled Python/native package's license and notices | Built from original locked dependencies; local MS Office itself is not bundled |

The upstream `THIRD_PARTY_NOTICES.md` included under `overlay/` is generated from direct dependencies and other documented runtime members. It must **not** be mistaken for a complete final legal inventory of every transitive or native binary component.

**Pengyu Fu's original Workbench contributions are licensed for noncommercial use under MRW-NC-1.0, as specifically scoped in [`LICENSE-SCOPE.md`](LICENSE-SCOPE.md). Commercial use of those original portions requires Pengyu Fu's prior written authorization.** This project-specific source-available license does not alter the MIT, Apache, MPL, LGPL or other rights granted for the third-party portions. A separately distributed compiled execution module is governed by its own formal license and does not convey its private source code. If an earlier version of a particular contribution was validly distributed under MIT, the historical license remains valid for that version.

**Complete Windows binary distribution limitation:** Pengyu Fu is the named licensor of the original Workbench portions (see LICENSE). The separately compiled proprietary runtime, actual native binary notices, corresponding-source availability and LGPL/MPL obligations must be cleared for full Windows application distribution. Source repository access alone does not authorize distribution of those restricted binary assets.
