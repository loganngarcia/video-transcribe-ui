import { Wasmer } from '@wasmer/sdk/browser';

const emit = detail => window.dispatchEvent(new CustomEvent('camera-browser-python', { detail }));
const probe = `
import importlib.util, json, platform, sys
mods = {name: importlib.util.find_spec(name) is not None for name in ("torch", "cv2", "mediapipe", "numpy")}
print(json.dumps({
  "python": sys.version.split()[0],
  "platform": platform.platform(),
  "modules": mods,
  "usr2_browser_ready": all(mods.values())
}))
`;

async function start() {
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    emit({state:'blocked', title:'Browser Python needs one refresh', detail:'Secure browser isolation is being enabled automatically on the hosted demo.'});
    return;
  }
  emit({state:'loading', title:'Starting Python in your browser…', detail:'Wasmer downloads the Python runtime once, then keeps it in browser storage.'});
  try {
    const wasmer = new Wasmer();
    const sandbox = await wasmer.sandboxes.create({packages:['python/python@=3.13.18']});
    const output = await sandbox.command('python', ['-c', probe]).run();
    const info = JSON.parse(output.text().trim());
    window.CameraPython = {
      info,
      run: async (code, args=[]) => (await sandbox.command('python', ['-c', code, ...args]).run()).text(),
      close: async () => { await sandbox.close(); await wasmer.close(); }
    };
    if (info.usr2_browser_ready) {
      emit({state:'ready', title:`Browser Python ${info.python} is ready`, detail:'This browser has the native modules USR 2.0 needs. Browser inference can be enabled.'});
    } else {
      const missing = Object.entries(info.modules).filter(([,ok])=>!ok).map(([name])=>name).join(', ');
      emit({state:'partial', title:`Browser Python ${info.python} is ready`, detail:`Wasmer is running locally. Full USR 2.0 still needs native modules not available in this WASIX runtime: ${missing}.`});
    }
  } catch (error) {
    emit({state:'error', title:'Browser Python could not start', detail:error?.message || 'Wasmer failed to initialize in this browser.'});
  }
}

start();
