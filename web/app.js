import {endpointURL, wordCount, clock, videoType} from './core.js';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('camera-preferences') || '{}'); } catch {}
const local = ['localhost','127.0.0.1'].includes(location.hostname);
let endpoint = prefs.endpoint || window.CAMERA_CONFIG?.apiBase || (local ? location.origin : 'http://localhost:8000');
let mode = prefs.mode || 'balanced', key = '', ready = false, busy = false, stream, recorder, clip, previewURL, jobId, cancelRequested = false, timer, connectEpoch = 0;
const history = [];
let selected, acquiring = false;
const notice = message => { $('notice').textContent = message; };
const runtimeStates = new Set(['ready','partial']);
window.addEventListener('camera-browser-python', event => {
  const detail=event.detail||{};
  const title=$('browser-runtime-title'), info=$('browser-runtime-detail'), dot=$('browser-runtime-dot');
  if(title) title.textContent=detail.title||'Browser Python';
  if(info) info.textContent=detail.detail||'';
  if(dot) dot.classList.toggle('ready',runtimeStates.has(detail.state));
});
const headers = () => key ? {Authorization:`Bearer ${key}`} : {};
async function api(path, options = {}, timeout = 10000) {
  const response = await fetch(endpoint + path, {...options, headers:{...headers(),...options.headers}, signal:AbortSignal.timeout(timeout)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'The reader could not complete this request.');
  return data;
}
function controls() {
  const recording = recorder?.state === 'recording';
  $('record').disabled = !stream || busy;
  $('record').textContent = recording ? 'Stop recording' : 'Start recording';
  $('upload').disabled = busy || recording;
  $('transcribe').disabled = !clip || !ready || busy;
  $('discard').disabled = busy;
  $('enable').disabled = busy || acquiring;
  $('settings-open').disabled = busy;
  $('connect').disabled = busy;
}
async function connect() {
  const epoch = ++connectEpoch;
  ready = false; controls();
  $('connection-title').textContent = 'Connecting to your reader…';
  $('connection-dot').classList.remove('ready');
  try {
    endpoint = endpointURL(endpoint);
    const health = await api('/api/health', {}, 8000);
    if (epoch !== connectEpoch) return;
    if (health.version !== 1 || health.modality !== 'video') throw new Error('This address is not a compatible camera reader.');
    ready = health.status === 'ready';
    $('connection-title').textContent = ready ? 'Your reader is ready' : health.message;
    $('connection-detail').textContent = ready ? `Clips are sent only when you transcribe · ${new URL(endpoint).host}` : 'The model is loading on your reader.';
    $('connection-dot').classList.toggle('ready', ready);
    if (health.status === 'loading') setTimeout(() => { if (epoch === connectEpoch) connect(); }, 5000);
  } catch (error) {
    if (epoch !== connectEpoch) return;
    $('connection-title').textContent = 'Connect a reader to get started';
    $('connection-detail').textContent = error.message.includes('key') ? error.message : 'Open Settings to connect your local or hosted USR 2.0 server.';
  }
  controls();
}
function settings() { $('endpoint').value=endpoint; $('key').value=key; $('mode').value=mode; $('settings').showModal(); }
$('settings-open').onclick = settings;
$('connect').onclick = settings;
$('help-open').onclick = () => $('help').showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('settings-form').onsubmit = event => {
  event.preventDefault();
  try { endpoint = endpointURL($('endpoint').value.trim()); } catch(error) { $('endpoint').setCustomValidity(error.message); $('endpoint').reportValidity(); return; }
  key=$('key').value.trim(); mode=$('mode').value;
  try {localStorage.setItem('camera-preferences',JSON.stringify({endpoint,mode}));} catch {}
  $('settings').close(); connect();
};
$('endpoint').oninput = () => $('endpoint').setCustomValidity('');
function stopCamera() {
  if (recorder?.state === 'recording') recorder.stop();
  stream?.getTracks().forEach(track => track.stop()); stream=null;
  $('video').srcObject=null;
  $('dropzone').classList.remove('live'); $('guide').hidden=true; $('video-label').hidden=true; $('camera-off').hidden=true;
  $('camera-empty').hidden=!!clip; controls();
}
function clearClip() {
  clip=null;
  if(previewURL) URL.revokeObjectURL(previewURL);
  previewURL=null; $('video').removeAttribute('src'); $('video').controls=false; $('clip').hidden=true;
  $('camera-empty').hidden=!!stream; controls();
}
$('enable').onclick = async () => {
  if (acquiring || stream) return;
  acquiring = true; controls();
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost and a supported browser. You can also upload a clip.');
    stream = await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:25,max:30}},audio:false});
    clearClip(); $('video').srcObject=stream; await $('video').play();
    $('camera-empty').hidden=true; $('guide').hidden=false; $('video-label').hidden=false; $('camera-off').hidden=false; $('dropzone').classList.add('live'); controls(); notice('Camera on. Start recording when you are ready.');
  } catch(error) { stopCamera(); notice(error.name==='NotAllowedError' ? 'Camera permission was declined. Allow access in your browser or upload a clip.' : error.message); } finally { acquiring = false; controls(); }
};
$('camera-off').onclick=stopCamera;
function selectClip(blob, name) {
  clearClip(); clip=blob; stopCamera(); previewURL=URL.createObjectURL(blob); $('video').src=previewURL; $('video').controls=true; $('video').muted=true; $('camera-empty').hidden=true; $('clip-name').textContent=name; $('clip').hidden=false; controls(); notice('Preview your clip, then choose Transcribe.');
}
$('record').onclick = () => {
  if(recorder?.state==='recording') { recorder.stop(); return; }
  try {
    const mime = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    const chunks=[];
    recorder=new MediaRecorder(stream, {...(mime ? {mimeType:mime} : {}),videoBitsPerSecond:1500000});
    recorder.ondataavailable=event => { if(event.data.size) chunks.push(event.data); };
    recorder.onerror=() => { clearInterval(timer); stopCamera(); notice('Recording failed. Try uploading a clip instead.'); };
    recorder.onstop=() => { clearInterval(timer); $('timer').hidden=true; selectClip(new Blob(chunks,{type:recorder.mimeType}), 'Your recording'); };
    recorder.start(500); const started=performance.now(); $('timer').hidden=false; $('timer').textContent='0:00 / 0:20';
    timer=setInterval(()=> { const seconds=(performance.now()-started)/1000; $('timer').textContent=`${clock(seconds)} / 0:20`; if(seconds>=19.8 && recorder.state==='recording') recorder.stop(); },100);
    controls(); notice('Recording video only. Click Stop when you finish.');
  } catch(error) {notice('This browser cannot record video. Try uploading an MP4 clip.');}
};
async function upload(file) {
  if(!file || busy || recorder?.state==='recording') return;
  if(file.size>50*1024*1024) return notice('Choose a video under 50 MB.');
  const type=videoType(file.name) || file.type;
  if(!['video/mp4','video/webm','video/quicktime','video/x-msvideo'].includes(type)) return notice('Choose MP4, MOV, WebM or AVI video.');
  const probe=document.createElement('video'), url=URL.createObjectURL(file);
  try {
    await new Promise((resolve,reject)=>{ const timeout=setTimeout(()=>reject(new Error('Cannot preview this video. Try an MP4 or WebM clip.')),8000); probe.onloadedmetadata=()=>{clearTimeout(timeout);resolve();};probe.onerror=()=>{clearTimeout(timeout);reject(new Error('Cannot preview this video in your browser. Try MP4 or WebM.'));};probe.src=url; });
    if(probe.duration>20.3 || probe.duration<0.4) throw new Error('Choose a clip between half a second and 20 seconds.');
    selectClip(new Blob([file],{type}),file.name);
  } catch(error) {notice(error.message);} finally {probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);}
}
$('upload').onclick=()=>$('file').click();
$('file').onchange=()=>{upload($('file').files[0]);$('file').value='';};
$('dropzone').ondragover=e=>{e.preventDefault();$('dropzone').classList.add('drag');};
$('dropzone').ondragleave=()=>$('dropzone').classList.remove('drag');
$('dropzone').ondrop=e=>{e.preventDefault();$('dropzone').classList.remove('drag');upload(e.dataTransfer.files[0]);};
$('discard').onclick=()=>{clearClip();notice('Clip discarded. Enable the camera to start again.');};
function resultControls() { const hasText=!!$('text').value.trim() && !busy; ['copy','speak','download'].forEach(id=>$(id).disabled=!hasText); $('word-count').textContent=`${wordCount($('text').value)} words`; }
function renderHistory() { $('history').replaceChildren();$('session').hidden=!history.length; for(const item of history) {const button=document.createElement('button');button.textContent=item.edited || item.text;button.onclick=()=>{if(!busy) show(item);};$('history').append(button);} }
function show(item) { selected=item; $('empty-result').hidden=true;$('result').hidden=false;$('text').value=item.edited ?? item.text;$('original').textContent=item.text;$('elapsed').textContent=`${item.seconds}s processing`;$('result-tag').textContent='YOURS TO EDIT';$('alternatives').replaceChildren();for(const text of item.alternatives||[]) {const li=document.createElement('li');li.textContent=text;$('alternatives').append(li);}resultControls(); }
function finish() {busy=false;jobId=null;$('busy').hidden=true;$('result').hidden=!selected;$('empty-result').hidden=!!selected;controls();resultControls();}
$('transcribe').onclick=async()=>{
  if(!clip||busy||!ready)return;
  busy=true;cancelRequested=false;$('busy').hidden=false;$('result').hidden=true;$('empty-result').hidden=true;$('stage').textContent='Uploading your clip…';controls();resultControls();
  try {
    // Do not abort an accepted upload: retain its id so cancellation can clean it up.
    const created=await api(`/api/jobs?mode=${encodeURIComponent(mode)}`,{method:'POST',headers:{'Content-Type':clip.type.split(';')[0]},body:clip},70000);jobId=created.id;
    const started=Date.now();let failures=0;
    while(Date.now()-started<20*60*1000) {
      if(cancelRequested) {await api(`/api/jobs/${jobId}`,{method:'DELETE'});notice('Cancelled. Any running computation will finish before its video is deleted.');finish();return;}
      let status;
      try {status=await api(`/api/jobs/${jobId}`);failures=0;} catch(error) {if(++failures>3)throw error;await sleep(3000);continue;}
      $('stage').textContent=status.stage || 'Reading your words…';
      if(status.state==='error')throw new Error(status.error);
      if(status.state==='cancelled')throw new Error('This reading was cancelled.');
      if(status.state==='done') { const item={...status.result};await api(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{});history.unshift(item);if(history.length>30)history.pop();finish();show(item);renderHistory();notice('Your reading is ready. Please review the words.');return; }
      await sleep(1000);
    }
    throw new Error('The reader is taking too long. Try a shorter clip or a faster server.');
  } catch(error) {if(jobId)await api(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{});notice(error.message || 'Connection lost. Check your reader and try again.');finish();}
};
$('cancel').onclick=()=>{cancelRequested=true;$('stage').textContent='Cancelling…';};
$('text').oninput=()=>{if(selected)selected.edited=$('text').value;resultControls();renderHistory();};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('text').value);notice('Copied to clipboard.');}catch{$('text').focus();$('text').select();notice('Select Copy from your browser to copy the selected text.');}};
$('speak').onclick=()=>{if(!('speechSynthesis'in window))return notice('Read aloud is not supported by this browser.');speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance($('text').value));};
$('download').onclick=()=>{const url=URL.createObjectURL(new Blob([$ ('text').value],{type:'text/plain;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='camera-transcript.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('clear').onclick=()=>{if(busy)return;history.length=0;selected=null;$('text').value='';$('original').textContent='';$('alternatives').replaceChildren();$('elapsed').textContent='';$('result-tag').textContent='READY WHEN YOU ARE';window.speechSynthesis?.cancel();$('result').hidden=true;$('empty-result').hidden=false;renderHistory();resultControls();notice('Session history cleared.');};
window.addEventListener('pagehide',()=>{clearInterval(timer);if(recorder)recorder.onstop=null;stopCamera();if(previewURL)URL.revokeObjectURL(previewURL);window.speechSynthesis?.cancel();});
connect();
