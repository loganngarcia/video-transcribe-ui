# Attribution

- **USR 2.0**, Andreas Haliassos and collaborators: https://github.com/ahaliassos/usr2. Revision `df0c78b7a3807e625a0fcdadd14b1cf674d21c91`. CC BY-NC 4.0. The native Huge checkpoint is downloaded separately. The browser build includes a derivative of the official Base+ checkpoint containing the visual encoder and CTC head, converted to FP16 ONNX and split into static chunks under `web/public/model/`. This project adds the browser conversion/export pipeline, persistent native video-only adapter, normalization and web application. See the upstream README for paper citation and licensing.
- **Chaplin UI**, Chaplin-UI Contributors: https://github.com/loganngarcia/chaplin-ui, based on Chaplin by Amanvir Parhar (https://github.com/amanvirparhar/chaplin). System palette, typography and rounded-panel design adapted for this interface. Full MIT attribution retained in `CHAPLIN-LICENSE.txt`.
- **MediaPipe**, Google: Apache 2.0. The USR2 checkout includes the face-landmarker asset; retain upstream notices.
- PyTorch, torchvision, torchaudio, FastAPI, Uvicorn, OpenCV, Hydra and other packages retain their individual licenses. FFmpeg licensing depends on the build installed. This archive does not bundle those packages or binaries.

USR2 preprocessing and ESPnet components carry additional upstream notices. Downloading the complete pinned source preserves them. Retain them in packaged deployments.

## Wasmer SDK

Browser Python integration uses `@wasmer/sdk` 0.11.0 from Wasmer. See https://github.com/wasmerio/wasmer-sdk for its current license and notices.

## coi-serviceworker

`web/public/coi-serviceworker.js` is derived from `coi-serviceworker` 0.1.7 by Guido Zuidhof and contributors, MIT licensed. Source: https://github.com/gzuidhof/coi-serviceworker.


## Browser inference runtimes

- **ONNX Runtime Web** is used to execute the converted USR 2.0 browser graph with WebGPU or WASM.
- **MediaPipe Tasks Vision** provides the in-browser Face Landmarker used before USR mouth preprocessing.
- These libraries retain their upstream licenses and notices as distributed through their npm packages.
