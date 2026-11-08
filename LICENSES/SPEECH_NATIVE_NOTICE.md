# Native speech components — MyResearchWorkbench 0.12.0

## Distribution and rights

The Windows package includes `sherpa-onnx-node@1.13.8` and `sherpa-onnx-win-x64@1.13.8`. Their npm manifests declare Apache-2.0 for Sherpa's original code. The supplied native libraries also contain eSpeak NG code under GPL-3.0-or-later, linked through Piper phonemize. The native combination therefore carries the applicable GPL terms; an Apache-only description of the binary is incomplete. Original Apache, MIT, BSD, Unicode and MPL notices for its constituent files remain effective.

Pengyu Fu's MRW-NC-1.0 and proprietary runtime EULA do not restrict the rights granted by these third-party licenses, including commercial redistribution, source access, modification and replacement of covered components. This statement does not relicense independently licensed Workbench code.

The corresponding source and build material is supplied together with the program in `MyResearchWorkbench_0.12.0_ThirdParty_Source.zip`, under `speech-native/`. See its `SOURCE_MANIFEST.json` and `BUILD_AND_REPLACE.md`. The full GPL text is preserved in `THIRD_PARTY_ORIGINALS/GNU-GPL-3.0.txt`; exact upstream notices are additionally preserved under `THIRD_PARTY_ORIGINALS/Native-Speech/`.

## Exact source identities

- Sherpa 1.13.8 npm gitHead: [11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf](https://github.com/csukuangfj/sherpa-onnx/tree/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf).
- eSpeak NG for Piper: [ed530aa113046142eb5115cf2fc9157854d0ffe1](https://github.com/csukuangfj/espeak-ng/tree/ed530aa113046142eb5115cf2fc9157854d0ffe1).
- Piper phonemize: [f3ff95afc03640bc1399e113e83361192a2fafb4](https://github.com/csukuangfj/piper-phonemize/tree/f3ff95afc03640bc1399e113e83361192a2fafb4).
- ONNX Runtime 1.28.2: [33ca9628233dc8f002435e868d4c2e9f82766ca1](https://github.com/microsoft/onnxruntime/tree/33ca9628233dc8f002435e868d4c2e9f82766ca1). Its MIT license and complete `ThirdPartyNotices.txt` are distributed separately alongside this notice.
- Other native source versions and hashes, including Kaldi, OpenFST, Eigen, KissFFT, JSON and sentencepiece, are recorded in the source companion. All source archives and upstream patches are retained under their original licenses.

MyResearchWorkbench does not modify the distributed Sherpa/eSpeak/ONNX binaries. Upstream fork modifications are part of the pinned complete source archives. The original npm publishing workflow and the pinned ONNX Windows build workflow identify the build settings.

## Workbench process boundary

Harness launches the speech recognizer as a separate Node/Electron child process. It sends WAV audio over authenticated loopback HTTP and receives JSON containing transcript text and timing. The original MIT-licensed speech worker source is included in the source companion; the proprietary Workbench assistant is not imported into this worker. Native library loading occurs in the worker.

The technical distribution treats this speech program and the independent Workbench application as separate programs distributed together. Process separation and ordinary audio/text interchange are documented facts, not a general legal rule that every separate process automatically avoids GPL coverage.

The source, notices and replacement instructions are provided for recipients' exercise of their rights. A full modified-source rebuild and byte-for-byte reproduction of the upstream native binaries have not been performed by this release closeout. No such test result is claimed.

Source or notice requests: fpy19941225@163.com.
