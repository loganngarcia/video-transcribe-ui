import { chromium } from 'playwright';
import path from 'node:path';

const sample = path.resolve(process.argv[2] || 'browser-smoke.mp4');
const url = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu', '--no-sandbox'],
});
const context = await browser.newContext();
await context.addInitScript(() => {
  localStorage.setItem('camera-preferences', JSON.stringify({
    readerKind: 'local',
    mode: 'fast',
  }));
  try {
    Object.defineProperty(Navigator.prototype, 'gpu', {get: () => undefined});
  } catch {}
});
const page = await context.newPage();
page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
page.on('pageerror', error => console.error('[pageerror]', error.stack || error.message));

try {
  await page.goto(url, {waitUntil:'domcontentloaded', timeout:120000});
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, {timeout:60000});
  await page.waitForFunction(
    () => document.querySelector('#connection-title')?.textContent?.includes('Ready to record'),
    null,
    {timeout:60000},
  );

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

  await page.setInputFiles('#file', sample);
  await page.waitForFunction(
    () => document.querySelector('#busy')?.hidden === false &&
          document.querySelector('#video-processing')?.hidden === false &&
          document.querySelector('#result-tag')?.textContent?.includes('TRANSCRIBING'),
    null,
    {timeout:30000},
  );

  await page.waitForFunction(() => {
    const result = document.querySelector('#result');
    const notice = document.querySelector('#notice')?.textContent || '';
    const failed = /could not|unavailable|incomplete|no words recognized|failed|error/i.test(notice);
    return result?.hidden === false || failed;
  }, null, {timeout:900000});

  const transcript = await page.inputValue('#text');
  const notice = await page.textContent('#notice');
  const connection = await page.textContent('#connection-detail');
  console.log(JSON.stringify({transcript, notice, connection, python, isolated: await page.evaluate(()=>crossOriginIsolated)}, null, 2));

  if (!transcript.trim()) throw new Error('Browser VSR returned an empty transcript: ' + notice);
  if ((transcript.trim().match(/\S+/g) || []).length < 2) throw new Error('Browser VSR returned fewer than two words: ' + transcript);
} finally {
  await browser.close();
}
