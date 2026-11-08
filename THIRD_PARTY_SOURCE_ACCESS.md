# Third-party source access — MyResearchWorkbench 0.12.0 Windows x64

The official [v0.12.0 Release](https://github.com/PengyuFu/MyResearchWorkbench/releases/tag/v0.12.0) supplies the Windows binary, `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip`, `MyResearchWorkbench_0.12.0_SourceBuildAssets.zip` and their `SHA256SUMS.txt` together. Source archives are available without an API account or product activation. Use the same version and verify its checksums.

## LGPL libraries and Cairo

The third-party source ZIP contains fixed upstream source archives for libvips 8.18.7, GLib 2.90.0, FriBidi 1.0.17, libexif 0.6.26, libheif 1.23.5, librsvg 2.63.2, Pango 1.58.2, proxy-libintl 0.5 and Cairo 1.18.6, plus fixed Windows build recipes, patches and MXE toolchain source. Exact source identities and hashes are in its `SOURCE_MANIFEST.json`.

The application uses the official static-web family of libvips, linked as a replaceable DLL. Its dependent libraries are statically linked inside that DLL. See the source ZIP's `BUILD_AND_REPLACE.md` for the build target and replacement procedure, including keeping the Sharp ABI compatible. Original GPL/LGPL texts and native dependency notices are retained in `licenses/THIRD_PARTY_ORIGINALS/`.

## Electron and FFmpeg

The source companion's `electron-ffmpeg/` directory includes fixed Electron 44.7.0 source, its FFmpeg patch and build instructions, and the corresponding Chromium FFmpeg source at `2b68d2babae73714846961fb0ee47e3b3d2e39a9`. The distributed root `ffmpeg.dll` matches the official Electron archive. Original Electron/Chromium notices remain in `LICENSE.electron.txt` and `LICENSES.chromium.html`. See the source companion's build/replacement instructions for LGPL-covered FFmpeg.

## LibreOffice Kit (MPL-2.0)

The distributed `@deepseek-ai/libreoffice-kit-win32-x64@0.1.5` retains `sources/`, patches, source metadata, build scripts and `licenses/`. LibreOffice Core revision: [bce0998afefdbc355585ca324285661a2170ba77](https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77). Integration source: [deepseek-ai/dsh-libreoffice-kit](https://github.com/deepseek-ai/dsh-libreoffice-kit).

The source companion also exposes the packaged integration sources and notices as ordinary files under `libreoffice-kit/`, so they can be read without extracting ASAR. Follow its `core-source.json` and `core-changes.patch` for the exact covered upstream source and modifications. MPL-covered source remains available under MPL; the original Workbench license does not restrict its rights.

## Native speech libraries (including GPL-covered eSpeak NG)

The distributed Sherpa 1.13.8 Windows DLLs contain eSpeak NG through Piper phonemize. Their native distribution is not described solely by the Apache license in the npm manifest. The source ZIP includes `speech-native/` with pinned Sherpa/eSpeak/Piper and dependent sources, build recipes, the original MIT speech worker source, source hashes and replacement instructions. ONNX Runtime 1.28.2 copyright and third-party notices are preserved. See `licenses/SPEECH_NATIVE_NOTICE.md` for component identities, applicable GPL rights and the separate speech-process boundary.

## Harness, DOCX Core and other components

- [Workbench source overlay](https://github.com/PengyuFu/MyResearchWorkbench/tree/v0.12.0), including fixed [Harness](https://github.com/deepseek-ai/deepseek-harness) commit and the full DOCX Core modification patch.
- [EigenPal DOCX Editor](https://github.com/eigenpal/docx-editor) Core 2.33.0 with `mrw.5` patch, under Apache-2.0; Pro/Editor API are excluded.
- `licenses/THIRD_PARTY_COMPONENT_NOTICE_INDEX.json` maps the previously missing top-level notices to actual component versions, preserved notice files and source evidence. Existing package-level notices remain in place.
- `licenses/THIRD_PARTY_SOURCE_AVAILABILITY.md` gives additional component details.

All third-party copyright, license, modification and redistribution rights remain independent. The MRW-NC-1.0 and proprietary runtime EULA apply only within their stated original Workbench scopes. They do not prevent modification, replacement or debugging of LGPL components. No proprietary Workbench source is required to replace these DLLs.

Contact for missing corresponding source or license material: fpy19941225@163.com.
