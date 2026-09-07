# Validation status

Recorded **2026-09-07**. These are smoke/integration checks, not production benchmarks or a dataset-level accuracy evaluation.

## Browser-only USR 2.0 Base+ — passed

The production Vite build was served exactly as a static site and tested in headless Chromium with the native server path disabled. The test uses the same public 4.03-second MultiVSR sample used for the native smoke test.

| Check | Observed result |
| --- | --- |
| Cross-origin isolation | `window.crossOriginIsolated === true` |
| Wasmer browser Python | **CPython 3.13.15** started successfully |
| Wasmer command execution | `print(6 * 7)` returned **42** |
| Wasmer worker companion assets | `node-network-rpc.js`, `capi-worker-bridge.js`, and generated snippets all returned **HTTP 200** |
| Browser model | **USR 2.0 Base+ visual encoder + CTC head** |
| Browser model payload | **224,984,858 bytes**, FP16 internals, float32 I/O, split into **5** static chunks |
| Execution provider in CI | threaded **WASM** |
| Video upload to inference server | **None** |
| Real browser transcript | **THIS PART OF THE PARADLY PEOPLE THAT CAME OUT WE CAN** |
| Browser smoke workflow | **Passed** |
| GitHub Pages production build | **Passed** |

The browser path uses MediaPipe Face Landmarker, reproduces the upstream MediaPipe 478→68 mapping and USR mouth preprocessing, executes the converted visual encoder + CTC projection with ONNX Runtime, then performs greedy CTC collapse in JavaScript.

This proves that the deployed architecture can produce text from a real video **without an inference server**. It does **not** establish browser WER. The browser decoder is simpler than the upstream ESPnet beam search, and the observed transcript is less accurate than the native Huge result below.

The exported browser ONNX graph SHA256 is:

`48e2e274c21e2953c8f694839bdf75b1f44ff4b332dd436977c2c3f67cfad476`

The official Base+ source checkpoint used for conversion had SHA256:

`4ab1f3f230aa6a724bcc698db8a17f2f54919136d2885c1a07a6b69247012773`

Upstream source revision: `df0c78b7a3807e625a0fcdadd14b1cf674d21c91`.

## Native USR 2.0 Huge inference — passed

Python 3.12, PyTorch 2.8.0+cpu, four intra-op threads, Linux CPU. Input was the same 4.03-second public MultiVSR sample; the video is not redistributed here.

| Check | Observed result |
| --- | --- |
| Model startup, direct adapter test | **36.90 seconds** |
| Fast inference after normalization | **7.24 seconds** |
| Balanced inference after normalization | **36.98 seconds** |
| Balanced full API job submission through result | **38.24 seconds** |
| Face landmark detection coverage | **100%** of frames |
| Audio input | **None; video-only encoder path** |
| Retrieve result then DELETE | **Passed** |

Fast and Balanced returned:

> THIS IS PART OF THE PARADISE PAPERS THAT CAME OUT THIS WEEKEND

Balanced returned additional hypotheses. Machine-readable evidence is in `tests/real-inference-result.json`. These are individual CPU observations, not a latency guarantee or a reproduction of the upstream **17.6% LRS3 visual-only WER**.

## Automated checks — 11 passed

Six Python tests cover actual FFmpeg audio removal and 25 FPS conversion, job lifecycle and temporary-file cleanup, invalid videos/origins/hosts, remote authentication, queue saturation/cancellation, and upload size limits.

Five Node tests cover endpoint validation, formatting, camera video-only constraints and track release, preview-to-transcription interactions and result clearing, and keeping connection keys out of saved preferences.

The production browser smoke is a separate end-to-end Playwright workflow and is **in addition to** those 11 deterministic tests.

## Remaining validation gates

- A physical camera-device run was not automated; the end-to-end browser test uses a real uploaded video file through the production UI.
- **WebGPU** is preferred by the app when available, but the reproducible CI smoke currently forces the WASM fallback. WebGPU hardware/browser combinations still need broader compatibility testing.
- Safari/iOS, Firefox, Android, and low-memory mobile devices have not received a full compatibility matrix.
- Browser Base+ + greedy CTC has not been evaluated across LRS3, so no browser WER is claimed.
- Intentionally silent mouthing can differ from ordinary vocalized speech with audio ignored.
- Native GPU, macOS, Windows, Thorough/beam-40, and worst-case 20-second native-memory behavior remain outside this validation set.

## Deployment status

Repository: `loganngarcia/video-transcribe-ui`

GitHub Pages is deployed through the included **Publish interface** workflow. The browser model is stored under `web/public/model/` and is served as five cacheable chunks. The default hosted reader is **This device**, so a public inference host is no longer required.

The optional connected-reader path remains for native USR 2.0 Huge or other server-side deployments.
