# Validation status

Recorded 2026-09-07. Do not equate these checks with production readiness.

## Actual USR 2.0 Huge inference — passed

Official source revision: `df0c78b7a3807e625a0fcdadd14b1cf674d21c91`. Official 7,597,175,714-byte Huge checkpoint. Python 3.12, PyTorch 2.8.0+cpu, four intra-op threads, Linux CPU. Input was a 4.03-second [public MultiVSR sample](https://github.com/Sindhu-Hegde/multivsr/blob/master/samples/GBfc471SoSo-00000.mp4); the video is not redistributed here.

| Check | Observed result |
| --- | --- |
| Model startup, direct adapter test | 36.90 seconds |
| Fast inference after normalization | 7.24 seconds |
| Balanced inference after normalization | 36.98 seconds |
| Balanced full API job submission through result | 38.24 seconds |
| Face landmark detection coverage | 100% of frames |
| Audio input | None; video-only encoder path |
| Retrieve result then DELETE | Passed; result becomes null |

Both modes returned:

> THIS IS PART OF THE PARADISE PAPERS THAT CAME OUT THIS WEEKEND

Balanced returned two additional hypotheses, including one with an initial “SO”. Machine-readable evidence is in `tests/real-inference-result.json`. These are individual CPU smoke-test observations, not a dataset WER measurement, latency guarantee, or validation of intentionally silent mouthing. The 17.6% upstream LRS3 result is not reproduced by this test.

## Automated checks — 11 passed

Six Python tests cover actual FFmpeg audio removal and 25 FPS conversion, job lifecycle and temporary-file cleanup, invalid videos/origins/hosts, remote authentication, queue saturation/cancellation, and upload size limits.

Five Node tests cover endpoint validation, formatting, camera video-only constraints and track release, preview-to-transcription interactions and result clearing, and keeping connection keys out of saved preferences. UI interaction tests run in jsdom with mocked media and network APIs; they are not browser/device compatibility tests. JavaScript syntax check passed.

Commands: `python -m pytest -q`, `npm ci`, `npm test`, `npm run check`.

## Remaining gates

- Browser rendering and real camera-device compatibility could not be checked: the available browser rejected localhost preview navigation with `ERR_BLOCKED_BY_CLIENT`. No visual QA or mobile-browser compatibility claim is made.
- Repository target is `loganngarcia/video-transcribe-ui`. GitHub Pages is configured through the included Actions workflow; deployment status must be checked after the push.
- No public HTTPS inference server has been provisioned. Static Pages assets alone cannot run this model.
- GPU, macOS, Windows, Baseplus, Thorough/beam-40 mode, 20-second worst-case memory use, and Docker are not tested.

## Wasmer browser-runtime integration — added 2026-09-07

The frontend now targets `@wasmer/sdk` 0.11.0 and Python `python/python@=3.13.18`. The GitHub Pages build uses `coi-serviceworker` 0.1.7 to provide the cross-origin isolation Wasmer requires on Pages. The runtime performs an in-browser import probe for `torch`, `cv2`, `mediapipe`, and `numpy` before claiming local USR compatibility.

This is deliberately **not** recorded as a passed USR browser-inference test. PyTorch, OpenCV and MediaPipe currently publish native desktop/server wheels, not WASIX browser wheels, so the browser runtime is a real CPython sandbox and capability layer but not a replacement for the tested native USR reader.
