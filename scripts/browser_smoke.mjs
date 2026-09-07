import { chromium } from 'playwright';
import path from 'node:path';

const sample = path.resolve(process.argv[2] || 'browser-smoke.mp4');
const fakeCamera = process.env.FAKE_CAMERA_Y4M ? path.resolve(process.env.FAKE_CAMERA_Y4M) : null;
const url = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const args = ['--disable-gpu', '--no-sandbox', '--use-fake-ui-for-media-stream'];
if (fakeCamera) {
  args.push('--use-fake-device-for-media-stream');
  args.push(`--use-file-for-fake-video-capture=${fakeCamera}`);
}

const browser = await chromium.launch({headless:true,args});
const context = await browser.newContext({permissions:['camera']});
await context.addInitScript(() => {
  localStorage.setItem('camera-preferences', JSON.stringify({
    readerKind: 'local',
    mode: 'fast',
  }));
  try {
    Object.defineProperty(Navigator.prototype, 'gpu', {get: () => undefined});
  } catch {}
  const htmlGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
    return htmlGetContext.call(this, type, ...args);
  };
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreenGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function(type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return offscreenGetContext.call(this, type, ...args);
    };
  }
  window.__WEBGL_BLOCKED_FOR_TEST__ = true;
});
const page = await context.newPage();
page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
page.on('pageerror', error => console.error('[pageerror]', error.stack || error.message));

async function requireVisibleAutoTranscription() {
  await page.waitForFunction(
    () => document.querySelector('#busy')?.hidden === false &&
          document.querySelector('#video-processing')?.hidden === false &&
          document.querySelector('#result-tag')?.textContent?.includes('TRANSCRIBING') &&
          !document.querySelector('#transcribe'),
    null,
    {timeout:30000},
  );
}

try {
  await page.goto(url, {waitUntil:'domcontentloaded', timeout:120000});
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, {timeout:60000});
  await page.waitForFunction(
    () => document.querySelector('#connection-title')?.textContent?.includes('Ready to record'),
    null,
    {timeout:240000},
  );
  const graphics = await page.evaluate(() => ({
    webgl: document.createElement('canvas').getContext('webgl'),
    backend: window.__VIDEO_TRANSCRIBE_FACE_BACKEND__,
    blocked: window.__WEBGL_BLOCKED_FOR_TEST__ === true,
  }));
  if (graphics.webgl !== null || graphics.backend !== 'tfjs-wasm' || !graphics.blocked) {
    throw new Error('WebGL-free face tracker was not active: ' + JSON.stringify(graphics));
  }

  await page.waitForFunction(
    () => window.CameraPython?.info?.python,
    null,
    {timeout:180000},
  );
  const python = await page.evaluate(async () => ({
    version: window.CameraPython.info.python,
    output: (await window.CameraPython.run("print(6 * 7)")).trim(),
  }));
  if (python.output !== '42') throw new Error('Wasmer CPython smoke failed: ' + JSON.stringify(python));

  let flow = 'upload';
  if (fakeCamera) {
    flow = 'camera';
    await page.click('#enable');
    await page.waitForFunction(
      () => document.querySelector('#dropzone')?.classList.contains('live') &&
            document.querySelector('#record')?.disabled === false,
      null,
      {timeout:30000},
    );
    await page.click('#record');
    await page.waitForFunction(
      () => document.querySelector('#record')?.textContent?.includes('Stop & transcribe'),
      null,
      {timeout:10000},
    );
    await page.waitForTimeout(2500);
    await page.click('#record');
    await page.waitForFunction(() => {
      const started=document.body.dataset.transcriptionStarted==='true';
      const busy=document.querySelector('#busy')?.hidden===false;
      const result=document.querySelector('#result')?.hidden===false;
      const error=document.querySelector('#error-result')?.hidden===false;
      return started && (busy || result || error);
    }, null, {timeout:30000});
    const immediateError = await page.evaluate(() =>
      document.querySelector('#error-result')?.hidden === false
        ? document.querySelector('#error-technical')?.textContent || document.querySelector('#error-message')?.textContent
        : ''
    );
    if (immediateError) throw new Error('Camera auto-transcription failed immediately: ' + immediateError);
  } else {
    await page.setInputFiles('#file', sample);
    await requireVisibleAutoTranscription();
  }

  await page.waitForFunction(() => {
    const result = document.querySelector('#result');
    const error = document.querySelector('#error-result');
    return result?.hidden === false || error?.hidden === false;
  }, null, {timeout:900000});

  const transcript = await page.inputValue('#text');
  const inputSource = await page.getAttribute('#result','data-input-source');
  const notice = await page.textContent('#notice');
  const connection = await page.textContent('#connection-detail');
  const error = await page.textContent('#error-message');
  console.log(JSON.stringify({
    flow,
    inputSource,
    transcript,
    notice,
    connection,
    error,
    python,
    graphics,
    isolated: await page.evaluate(()=>crossOriginIsolated),
  }, null, 2));

  if (flow==='camera' && inputSource!=='live-camera') throw new Error('Camera flow fell back to re-decoding the recording instead of live frames: ' + inputSource);
  if (!transcript.trim()) throw new Error('Browser VSR returned an empty transcript: ' + (error || notice));
  if ((transcript.trim().match(/\S+/g) || []).length < 2) throw new Error('Browser VSR returned fewer than two words: ' + transcript);
} finally {
  await browser.close();
}
