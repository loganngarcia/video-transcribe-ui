# Camera Transcribe

A camera-only speech-to-text interface inspired by [Chaplin UI](https://github.com/loganngarcia/chaplin-ui), with a persistent [USR 2.0](https://github.com/ahaliassos/usr2) reader. Record a short sentence, preview your clip, and turn visible speech into editable text. No microphone permission, no audio input to the model, no LLM rewriting.

**Experimental, noncommercial software.** The hosted UI now boots CPython locally through Wasmer in supported browsers, with no Python installation required. That browser runtime is used as a capability layer and future on-device path. Full USR 2.0 inference still requires the native reader today because upstream depends on PyTorch, OpenCV and MediaPipe native modules that are not available as WASIX browser wheels. Real USR 2.0 Huge inference passed in both Fast and Balanced modes on Linux CPU; see `VALIDATION.md`.

## What you get

- Chaplin-inspired rounded panels, system typography, blue actions, automatic dark mode, responsive layout, keyboard focus and accessible dialogs.
- Camera capture without microphone access, 20-second recording limit, local preview, drag-and-drop uploads.
- Editable transcripts, original model output and available alternatives, copy, text export and browser read-aloud.
- Memory-only session history; no analytics, external fonts, frontend packages or CDN dependencies.
- Persistent USR 2.0 Huge backend; fast, balanced and thorough decoding modes.
- Serialized inference, a bounded three-job queue, 50 MB upload limit, cancellation, temporary-video cleanup and expiring results.
- Automatic Wasmer CPython 3.13 browser sandbox with a capability probe and a small `window.CameraPython.run(...)` bridge for browser-local Python tasks.
- Setup scripts, automated tests, Docker recipe and GitHub Pages workflow.

## Run locally

Use **Python 3.12**, Git and FFmpeg. Linux is the primary target. Start with at least **16 GB RAM**, approximately **20 GB free disk** for CPU packages and weights, and short clips. Huge weights alone are approximately **7.6 GB**. A GPU improves responsiveness; CPU inference may take minutes. This is clip transcription, not a guaranteed real-time captioner.

Install FFmpeg with your operating system's package manager (`sudo apt install ffmpeg` on Ubuntu, `brew install ffmpeg` on macOS). Then, from this repository:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
# CPU-only Linux setup avoids installing large CUDA runtime packages:
pip install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
python scripts/setup_model.py
python scripts/run.py
```

Open **http://localhost:8000**. The first startup loads weights; wait for “Your reader is ready.” Enable your camera, record one sentence, stop, preview, then transcribe. Camera and clip previews remain local until you click Transcribe. Only one model worker is supported.

For CUDA, install the matching official PyTorch 2.8.0 build for your hardware instead of the CPU command. GPU, macOS, and Windows execution require separate validation; do not assume that a successful Linux CPU check verifies them.

Setup fetches the official source at `df0c78b7a3807e625a0fcdadd14b1cf674d21c91`, downloads the official Huge checkpoint, and writes a SHA256 manifest. Source and weights are excluded from Git. Google Drive may impose download quotas; a failure is reported and setup can be rerun. Do not substitute untrusted checkpoints.

Optional smaller model:

```bash
python scripts/setup_model.py --size baseplus
USR2_SIZE=baseplus USR2_CHECKPOINT=models/usr2-baseplus.pth python scripts/run.py
```

Baseplus is an optional integration path, not the Huge benchmark model; see validation status before relying on it.

## GitHub Pages, Wasmer and inference

The public site is designed for **zero-install browser use**. GitHub Pages serves the interface and the Wasmer JavaScript SDK starts CPython 3.13 inside the tab. Because Wasmer browser sandboxes require `SharedArrayBuffer`, the Pages build includes `coi-serviceworker` so cross-origin isolation is enabled automatically on GitHub Pages. The first visit may reload once while that service worker takes control.

Wasmer solves the Python-runtime part, but it does **not** make arbitrary Linux native wheels portable to WebAssembly. USR 2.0 currently requires PyTorch, OpenCV and MediaPipe, so the app performs a real in-browser capability probe and reports whether those modules exist instead of claiming inference works when they do not. As of this build, use the proven native reader for actual USR 2.0 transcription.

The browser sandbox is intentionally exposed as `window.CameraPython` after it starts. This lets future browser-side preprocessing or a WASIX-compatible USR runtime be added without changing the product flow. Example from DevTools:

```js
await CameraPython.run("print(sum(i*i for i in range(10)))")
```

Public deployment:

1. Push this repository to `main`.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The **Publish interface** workflow installs the pinned Wasmer SDK, builds the browser bundle and publishes `dist/`.
4. Optionally set repository variable `API_BASE_URL` to an HTTPS USR 2.0 reader. If omitted, the UI still starts Wasmer locally and explains that native USR inference needs a reader.

For personal testing, a local reader can still be used at `http://localhost:8000`. Browsers may ask for local-network permission when a GitHub Pages tab contacts localhost.

## Host the reader

Set a randomly generated connection key of at least 24 characters in your host's secret store, along with:

```text
CAMERA_PUBLIC=1
CAMERA_API_TOKEN=<secret from your host's secret store>
CAMERA_ORIGINS=https://loganngarcia.github.io
CAMERA_HOSTS=reader.your-domain.example
```

Run `python scripts/run.py --host 0.0.0.0` behind an HTTPS reverse proxy. Set proxy body limit to 50 MB, upload timeout to at least 70 seconds, and do not proxy-cache `/api/`. Keep one worker per model instance. Do not expose the development loopback configuration to the internet.

A CPU Docker recipe is included. Build it, use a writable persistent volume for `/app/models` and `/app/vendor`, run `python scripts/setup_model.py` in that container once, then start the default command with the environment above. The recipe is supplied for deployment; its test status is documented separately. Weights are deliberately not baked into the image.

| Variable | Default | Purpose |
| --- | --- | --- |
| `USR2_ROOT` | `vendor/usr2` | Pinned official source checkout |
| `USR2_CHECKPOINT` | `models/usr2-huge.pth` | Official checkpoint |
| `USR2_SIZE` | `huge` | `huge` or `baseplus`, matching weights |
| `USR2_DEVICE` | CUDA if available, else CPU | PyTorch device |
| `TORCH_THREADS` | `4`, capped at 8 | CPU intra-op threads |
| `CAMERA_API_TOKEN` | empty | Required for remote access |
| `CAMERA_PUBLIC` | unset | `1` enforces a strong connection key |
| `CAMERA_ORIGINS` | Pages origin and localhost:8000 | Comma-separated browser origins |
| `CAMERA_HOSTS` | Loopback hosts locally | Allowed Host headers; set explicitly remotely |

## Accuracy and privacy

USR 2.0's official Huge result is **17.6% LRS3 visual-only WER**. This is an upstream benchmark, **not an accuracy measurement of this app**. The app uses MediaPipe mouth tracking; detector choice, decoding settings, lighting and recording conditions affect results. LRS3 is mostly ordinary vocalized speech with audio ignored. Intentionally silent articulation can differ. Similar-looking sounds are fundamentally ambiguous.

All modes use video only. Balanced uses beam 10; Thorough uses beam 40; Fast uses beam 1 without CTC fusion. Larger beams can take substantially longer, and do not guarantee every sentence improves. Alternatives are model hypotheses, not calibrated confidence estimates. Face-tracking coverage is not word confidence.

Uploaded files can contain audio; that original upload reaches your selected server, which strips audio before inference. Recorded clips never include microphone audio. Server temporary files are removed after processing, including errors and cancellation. Cancellation cannot interrupt a native inference call already running. Results expire after five minutes; the UI asks the server to clear retrieved results. A server crash may leave temporary directories for the operating system to clean; use ephemeral storage for hosted deployments. No claim of secure erasure is made.

Transcripts stay in tab memory until refresh or Clear history. Only address and reading mode preferences are saved in local storage. Connection keys stay in memory. Clipboard, downloaded text and browser/OS speech synthesis are under your control and may outlive the tab. Server operators and hosting providers control their own access and logs.

## Development and tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
npm install
npm test
npm run check
npm run build
```

Frontend interaction tests use jsdom with mocked browser media/network APIs. Unit and API tests use a clearly named fake engine; they verify orchestration, validation, audio removal, cancellation and queue limits, **not recognition quality**. Real-model tests are separate. To smoke-test an actual video against a running reader:

```bash
python scripts/smoke_test.py path/to/clip.mp4 --mode fast
```

The script uses `CAMERA_API_TOKEN` from the environment if needed. It prints the actual transcript and timings, and fails on server/model errors. Use a clip you have permission to process. No example transcript is hardcoded into the app.

## Project layout

- `web/`: static frontend source plus the Wasmer browser-runtime entrypoint; Vite builds it for a GitHub Pages project subpath.
- `server/engine.py`: persistent official-model adapter; only `xs_v` enters the encoder.
- `server/media.py`: bounded FFmpeg normalization and audio stripping.
- `server/app.py`: API, lifecycle, jobs, origin/auth controls and static hosting.
- `scripts/`: setup, startup and real inference smoke test.
- `tests/`: deterministic frontend utility and backend integration tests.

## License and credits

This integration is distributed under **CC BY-NC 4.0**, matching the noncommercial use requested for USR 2.0. It is source-available for noncommercial use; that restriction is not an OSI open-source license. Original integration copyright © 2026 Camera Transcribe contributors. Adaptations include the new UI, persistent runtime wrapper, video-only loading, queue and deployment scripts.

USR 2.0 code and models remain subject to their authors' license and attribution. Chaplin-derived design elements retain the original MIT notice in `CHAPLIN-LICENSE.txt`. See `THIRD_PARTY_NOTICES.md` and the upstream source for additional component licenses. No model weights or third-party sample videos are redistributed in this repository.
