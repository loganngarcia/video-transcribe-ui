import {endpointURL, wordCount, clock, videoType} from './core.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('camera-preferences') || '{}'); } catch {}

const localHost = ['localhost','127.0.0.1'].includes(location.hostname);
let endpoint = prefs.endpoint || window.CAMERA_CONFIG?.apiBase || (localHost ? location.origin : 'http://localhost:8000');
let mode = prefs.mode || 'balanced';
let readerKind = prefs.readerKind || (localHost ? 'server' : 'local');
let key = '', ready = false, localReader = false, modelFailed = false, busy = false;
let stream, recorder, clip, previewURL, jobId, timer, connectEpoch = 0;
let cancelRequested = false, selected, acquiring = false, localPreloadPromise;
let clipSource='video', liveCaptureSession=null, liveCameraFrames=null;
const history = [];

const notice = message => { $('notice').textContent = message; };
function friendlyError(error) {
  const raw=String(error?.message||error||'Unknown error');
  if(/activeTexture|webgl|texture|gpu/i.test(raw)) {
    return {
      message:'Your browser graphics engine stopped during face tracking or transcription. Video Transcribe can retry in CPU/WASM compatibility mode.',
      raw
    };
  }
  if(/Cannot read properties|TypeError|undefined|is not a function/i.test(raw)) {
    return {message:'A browser runtime component stopped unexpectedly. Video Transcribe can retry this same video in compatibility mode.',raw};
  }
  if(/memory|out of memory|allocation/i.test(raw)) {
    return {message:'This browser ran out of memory while processing the video. Close other heavy tabs and try a shorter recording.',raw};
  }
  if(/decode|video/i.test(raw) && /could not|cannot|failed|unsupported/i.test(raw)) {
    return clipSource==='recording'
      ? {message:'The camera recording could not be reopened by this browser. Record again; Video Transcribe now reads camera frames live so this should only be a fallback error.',raw}
      : {message:'The browser could not decode this video file. Try an MP4 or WebM file.',raw};
  }
  return {message:raw.length<180?raw:'On-device transcription stopped unexpectedly. Try again or use compatibility mode.',raw};
}
function showTranscriptionError(error) {
  const info=friendlyError(error);
  $('error-message').textContent=info.message;
  $('error-technical').textContent=info.raw;
  $('error-technical-wrap').open=false;
}
const percent = value => Math.max(0,Math.min(100,Math.round((value || 0)*100)));
const formatBytes = bytes => {
  if(!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024**2 ? `${Math.round(bytes/(1024**2))} MB` : `${Math.round(bytes/1024)} KB`;
};
const formatEta = seconds => {
  if(seconds == null || !Number.isFinite(seconds)) return 'Estimating time remaining…';
  if(seconds <= 0) return 'Ready';
  if(seconds < 60) return `About ${Math.max(1,Math.round(seconds))} sec remaining`;
  return `About ${Math.ceil(seconds/60)} min remaining`;
};
function setRing(id,value,labelId) {
  const valuePercent=percent(value);
  const ring=$(id);
  if(!ring) return;
  ring.style.setProperty('--progress',String(valuePercent));
  ring.setAttribute('aria-valuenow',String(valuePercent));
  if(labelId && $(labelId)) $(labelId).textContent=valuePercent>=100?'✓':`${valuePercent}%`;
  ring.classList.toggle('complete',valuePercent>=100);
}
function setupProgress(detail={}) {
  if(detail.phase && detail.phase!=='setup') return;
  setRing('setup-ring',detail.progress,'setup-percent');
  if(detail.ready) {
    ready=true;modelFailed=false;
    $('connection-title').textContent='Ready to record';
    $('connection-detail').textContent='Everything needed for on-device transcription is loaded.';
    $('setup-eta').textContent='Your video stays on this device.';
    $('connection-dot').classList.add('ready');
    $('technical-reader-detail').textContent=`USR 2.0 Base+ · ${detail.provider || (navigator.gpu?'WebGPU':'WASM')} · local video only`;
    controls();
    return;
  }
  if(detail.error) {
    ready=false;modelFailed=true;
    $('connection-title').textContent='Transcription setup failed';
    $('connection-detail').textContent=detail.error;
    $('setup-eta').textContent='Open Options to use a connected reader instead.';
    $('connection-dot').classList.remove('ready');
    controls();
    return;
  }
  $('connection-title').textContent=detail.stage || 'Preparing transcription';
  const loaded=detail.bytesLoaded, total=detail.bytesTotal;
  if(loaded && total) {
    const speed=detail.speedBps ? ` · ${(detail.speedBps/(1024**2)).toFixed(1)} MB/s` : '';
    $('connection-detail').textContent=`${formatBytes(loaded)} of ${formatBytes(total)} downloaded${speed}`;
  } else {
    $('connection-detail').textContent='Loading the speech model and optimizing it for this device.';
  }
  $('setup-eta').textContent=formatEta(detail.etaSeconds);
  $('technical-reader-detail').textContent=`USR 2.0 Base+ · ${detail.provider || (navigator.gpu?'WebGPU':'WASM')} · on-device`;
}
function processProgress(detail={}) {
  let progress=detail.progress || 0;
  let stage=detail.stage || 'Transcribing automatically…';
  if(detail.phase==='setup') progress*=0.18;
  setRing('process-ring',progress,'process-percent');
  setRing('video-process-ring',progress,'video-process-percent');
  $('stage').textContent=stage;
  $('process-eta').textContent=formatEta(detail.etaSeconds);
  $('video-process-title').textContent=stage;
  $('video-process-detail').textContent=formatEta(detail.etaSeconds);
}

const runtimeStates = new Set(['ready','partial']);
window.addEventListener('camera-browser-python', event => {
  const detail=event.detail||{};
  if($('browser-runtime-title')) $('browser-runtime-title').textContent=detail.title||'Browser Python';
  if($('browser-runtime-detail')) $('browser-runtime-detail').textContent=detail.detail||'';
  if($('browser-runtime-dot')) $('browser-runtime-dot').classList.toggle('ready',runtimeStates.has(detail.state));
});
window.addEventListener('camera-model-progress', event => {
  const detail=event.detail||{};
  setupProgress(detail);
  if(busy && detail.phase==='setup') processProgress(detail);
});

const headers = () => key ? {Authorization:`Bearer ${key}`} : {};
async function api(path,options={},timeout=10000) {
  const response=await fetch(endpoint+path,{
    ...options,
    headers:{...headers(),...options.headers},
    signal:AbortSignal.timeout(timeout)
  });
  const data=await response.json();
  if(!response.ok) throw new Error(data.detail || 'The reader could not complete this request.');
  return data;
}

function controls() {
  const recording=recorder?.state==='recording';
  $('record').disabled=!stream || busy || (localReader && !ready);
  $('record').textContent=recording ? 'Stop & transcribe' : 'Start recording';
  $('upload').disabled=busy || recording;
  if($('new-video')) $('new-video').disabled=busy;
  $('enable').disabled=busy || acquiring;
  $('settings-open').disabled=busy;
  $('connect').disabled=busy;
}

function startLocalPreload(epoch) {
  localReader=true;ready=false;modelFailed=false;controls();
  setupProgress({
    phase:'setup',
    stage:'Preparing transcription',
    progress:0.01,
    etaSeconds:null,
    provider:navigator.gpu?'WebGPU':'WASM'
  });
  localPreloadPromise=import('./local-vsr.js')
    .then(runtime=>runtime.preloadLocalModel(setupProgress))
    .then(result=>{
      if(epoch!==connectEpoch) return result;
      ready=true;controls();
      return result;
    })
    .catch(error=>{
      if(epoch!==connectEpoch) return;
      setupProgress({phase:'setup',error:error.message || 'Could not prepare the on-device model.'});
    });
}

async function connect() {
  const epoch=++connectEpoch;
  ready=false;localReader=false;modelFailed=false;controls();
  $('connection-dot').classList.remove('ready');

  if(readerKind==='local') {
    startLocalPreload(epoch);
    return;
  }

  setRing('setup-ring',0.12,'setup-percent');
  $('connection-title').textContent='Connecting to your reader';
  $('connection-detail').textContent='Checking the server connection.';
  $('setup-eta').textContent='';
  try {
    endpoint=endpointURL(endpoint);
    const health=await api('/api/health',{},8000);
    if(epoch!==connectEpoch) return;
    if(health.version!==1 || health.modality!=='video') throw new Error('This address is not a compatible camera reader.');
    ready=health.status==='ready';
    setRing('setup-ring',ready?1:0.45,'setup-percent');
    $('connection-title').textContent=ready?'Connected reader ready':health.message;
    $('connection-detail').textContent=ready?`Using ${new URL(endpoint).host}`:'The server model is still loading.';
    $('setup-eta').textContent=ready?'Ready to record':'Waiting for the server…';
    $('connection-dot').classList.toggle('ready',ready);
    $('technical-reader-detail').textContent=`Connected USR reader · ${new URL(endpoint).host}`;
    if(health.status==='loading') setTimeout(()=>{if(epoch===connectEpoch)connect();},5000);
  } catch(error) {
    if(epoch!==connectEpoch) return;
    setRing('setup-ring',0,'setup-percent');
    $('connection-title').textContent='Could not connect to the reader';
    $('connection-detail').textContent=error.message.includes('key')?error.message:'Check the server address in Options.';
    $('setup-eta').textContent='';
  }
  controls();
}

function syncReaderSettings() {
  const localChoice=$('reader-kind').value==='local';
  $('server-settings').hidden=localChoice;
  $('endpoint').required=!localChoice;
}
function settings() {
  $('endpoint').value=endpoint;
  $('key').value=key;
  $('mode').value=mode;
  $('reader-kind').value=readerKind;
  syncReaderSettings();
  $('settings').showModal();
}
$('settings-open').onclick=settings;
$('connect').onclick=settings;
$('help-open').onclick=()=>$('help').showModal();
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
$('reader-kind').onchange=syncReaderSettings;
$('settings-form').onsubmit=event=>{
  event.preventDefault();
  readerKind=$('reader-kind').value;
  if(readerKind==='server') {
    try {endpoint=endpointURL($('endpoint').value.trim());}
    catch(error){$('endpoint').setCustomValidity(error.message);$('endpoint').reportValidity();return;}
    key=$('key').value.trim();
  }
  mode=$('mode').value;
  try {localStorage.setItem('camera-preferences',JSON.stringify({endpoint,mode,readerKind}));} catch {}
  $('settings').close();
  connect();
};
$('endpoint').oninput=()=>$('endpoint').setCustomValidity('');

function stopCamera() {
  if(recorder?.state==='recording') recorder.stop();
  if(liveCaptureSession && recorder?.state!=='recording') {
    try { liveCaptureSession.cancel(); } catch {}
    liveCaptureSession=null;
  }
  stream?.getTracks().forEach(track=>track.stop());
  stream=null;
  $('video').srcObject=null;
  $('dropzone').classList.remove('live');
  $('guide').hidden=true;
  $('video-label').hidden=true;
  $('camera-off').hidden=true;
  $('camera-empty').hidden=!!clip;
  controls();
}
function clearClip() {
  clip=null;
  clipSource='video';
  liveCameraFrames=null;
  if(previewURL) URL.revokeObjectURL(previewURL);
  previewURL=null;
  $('video').removeAttribute('src');
  $('video').controls=false;
  $('clip').hidden=true;
  if($('new-video')) $('new-video').hidden=true;
  $('video-processing').hidden=true;
  $('camera-empty').hidden=!!stream;
  controls();
}

$('enable').onclick=async()=>{
  if(acquiring||stream) return;
  acquiring=true;controls();
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS or localhost. You can also upload a video.');
    stream=await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:25,max:30}},
      audio:false
    });
    clearClip();
    $('video').srcObject=stream;
    await $('video').play();
    $('camera-empty').hidden=true;
    $('guide').hidden=false;
    $('video-label').hidden=false;
    $('camera-off').hidden=false;
    $('dropzone').classList.add('live');
    notice('Camera is on. Press Start recording and say one short sentence.');
  } catch(error) {
    stopCamera();
    notice(error.name==='NotAllowedError'?'Camera permission was declined. Allow camera access or upload a video.':error.message);
  } finally {
    acquiring=false;controls();
  }
};
$('camera-off').onclick=stopCamera;

function selectClip(blob,name,{source='video',cameraFrames=null}={}) {
  clearClip();
  clip=blob;
  clipSource=source;
  liveCameraFrames=cameraFrames;
  stopCamera();
  previewURL=URL.createObjectURL(blob);
  $('video').src=previewURL;
  $('video').controls=false;
  $('video').muted=true;
  $('camera-empty').hidden=true;
  $('clip-name').textContent=`${name} · transcription started automatically`;
  $('clip').hidden=false;
  $('new-video').hidden=true;
  notice(source==='recording'
    ? 'Recording stopped. Using the captured camera frames to transcribe now.'
    : 'Video selected. Transcribing automatically now.');
  void transcribeClip();
}

$('record').onclick=async()=>{
  if(recorder?.state==='recording'){recorder.stop();return;}
  try {
    const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
    const chunks=[];
    if(localReader) {
      const runtime=await import('./local-vsr.js');
      liveCaptureSession=await runtime.startLiveMouthCapture($('video'));
    }
    recorder=new MediaRecorder(stream,{...(mime?{mimeType:mime}:{}),videoBitsPerSecond:1500000});
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    recorder.onerror=()=>{
      clearInterval(timer);
      try { liveCaptureSession?.cancel(); } catch {}
      liveCaptureSession=null;
      stopCamera();
      notice('Recording failed. Try recording again.');
    };
    recorder.onstop=()=>{
      clearInterval(timer);
      $('timer').hidden=true;
      let cameraFrames=null;
      if(liveCaptureSession) {
        try { cameraFrames=liveCaptureSession.stop(); }
        catch(error) {
          liveCaptureSession=null;
          showTranscriptionError(error);
          $('error-result').hidden=false;
          $('empty-result').hidden=true;
          $('result-tag').textContent='NEEDS ATTENTION';
          stopCamera();
          return;
        }
        liveCaptureSession=null;
      }
      selectClip(new Blob(chunks,{type:recorder.mimeType}),'Recording complete',{source:'recording',cameraFrames});
    };
    // No timeslice: a single finalized blob is more broadly seekable/playable.
    recorder.start();
    const started=performance.now();
    $('timer').hidden=false;
    $('timer').textContent='0:00 / 0:20';
    timer=setInterval(()=>{
      const seconds=(performance.now()-started)/1000;
      $('timer').textContent=`${clock(seconds)} / 0:20`;
      if(seconds>=19.8&&recorder.state==='recording') recorder.stop();
    },100);
    controls();
    notice('Recording. Press Stop & transcribe when you finish.');
  } catch {
    notice('This browser cannot record video. Try uploading an MP4 or WebM video.');
  }
};

async function upload(file) {
  if(!file||busy||recorder?.state==='recording') return;
  if(file.size>50*1024*1024) return notice('Choose a video under 50 MB.');
  const type=videoType(file.name)||file.type;
  if(!['video/mp4','video/webm','video/quicktime','video/x-msvideo'].includes(type)) return notice('Choose an MP4, MOV, WebM or AVI video.');
  const probe=document.createElement('video'),url=URL.createObjectURL(file);
  try {
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Could not preview this video. Try MP4 or WebM.')),8000);
      probe.onloadedmetadata=()=>{clearTimeout(timeout);resolve();};
      probe.onerror=()=>{clearTimeout(timeout);reject(new Error('Could not preview this video in your browser. Try MP4 or WebM.'));};
      probe.src=url;
    });
    if(probe.duration>20.3||probe.duration<0.4) throw new Error('Choose a video between half a second and 20 seconds.');
    selectClip(new Blob([file],{type}),file.name,{source:'upload'});
  } catch(error) {
    notice(error.message);
  } finally {
    probe.removeAttribute('src');probe.load();URL.revokeObjectURL(url);
  }
}
$('upload').onclick=()=>$('file').click();
$('file').onchange=()=>{upload($('file').files[0]);$('file').value='';};
$('dropzone').ondragover=event=>{event.preventDefault();$('dropzone').classList.add('drag');};
$('dropzone').ondragleave=()=>$('dropzone').classList.remove('drag');
$('dropzone').ondrop=event=>{event.preventDefault();$('dropzone').classList.remove('drag');upload(event.dataTransfer.files[0]);};
$('new-video').onclick=()=>{
  clearClip();
  notice('Ready for another recording.');
  $('enable').click();
};

function resultControls() {
  const hasText=!!$('text').value.trim()&&!busy;
  ['copy','speak','download'].forEach(id=>$(id).disabled=!hasText);
  $('word-count').textContent=`${wordCount($('text').value)} words`;
}
function renderHistory() {
  $('history').replaceChildren();
  $('session').hidden=!history.length;
  for(const item of history){
    const button=document.createElement('button');
    button.textContent=item.edited||item.text;
    button.onclick=()=>{if(!busy)show(item);};
    $('history').append(button);
  }
}
function show(item) {
  selected=item;
  $('empty-result').hidden=true;
  $('result').hidden=false;
  $('text').value=item.edited??item.text;
  $('original').textContent=item.text;
  $('elapsed').textContent=`${item.seconds}s processing`;
  $('result-tag').textContent='READY TO REVIEW';
  $('alternatives').replaceChildren();
  for(const text of item.alternatives||[]){
    const li=document.createElement('li');li.textContent=text;$('alternatives').append(li);
  }
  resultControls();
}
function finish() {
  busy=false;jobId=null;
  $('busy').hidden=true;
  $('video-processing').hidden=true;
  if(clip) $('video').controls=true;
  $('result').hidden=!selected;
  $('empty-result').hidden=!!selected;
  if(clip) $('new-video').hidden=false;
  controls();resultControls();
}
function acceptResult(item) {
  history.unshift(item);
  if(history.length>30)history.pop();
  finish();show(item);renderHistory();
  notice(item.local?'Transcript ready. Processing stayed on this device.':'Transcript ready. Review the text before using it.');
}

async function transcribeClip() {
  if(!clip||busy) return;
  if(!localReader&&!ready) {
    $('error-result').hidden=false;
    showTranscriptionError(new Error('The connected reader is not ready. Check Options and try again.'));
    $('empty-result').hidden=true;
    $('result').hidden=true;
    $('result-tag').textContent='NEEDS ATTENTION';
    return;
  }
  if(localReader&&modelFailed) {
    $('error-result').hidden=false;
    showTranscriptionError(new Error('On-device transcription could not start. Open Options to use a connected reader.'));
    $('empty-result').hidden=true;
    $('result').hidden=true;
    $('result-tag').textContent='NEEDS ATTENTION';
    return;
  }

  busy=true;cancelRequested=false;
  $('error-result').hidden=true;
  $('busy').hidden=false;
  $('video-processing').hidden=false;
  $('result').hidden=true;
  $('empty-result').hidden=true;
  $('new-video').hidden=true;
  $('result-tag').textContent='TRANSCRIBING NOW';
  setRing('process-ring',0.01,'process-percent');
  setRing('video-process-ring',0.01,'video-process-percent');
  $('stage').textContent=localReader?'Transcribing automatically…':'Uploading and transcribing…';
  $('process-eta').textContent='Estimating time remaining…';
  $('video-process-title').textContent='Transcribing automatically…';
  $('video-process-detail').textContent='Starting now…';
  controls();resultControls();

  try {
    if(localReader) {
      const runtime=await import('./local-vsr.js');
      const item=await runtime.transcribeLocally(clip,processProgress,liveCameraFrames);
      if(cancelRequested){notice('Transcription cancelled.');finish();return;}
      acceptResult(item);
      return;
    }

    const created=await api(`/api/jobs?mode=${encodeURIComponent(mode)}`,{
      method:'POST',
      headers:{'Content-Type':clip.type.split(';')[0]},
      body:clip
    },70000);
    jobId=created.id;
    const started=Date.now();
    let failures=0;
    while(Date.now()-started<20*60*1000) {
      if(cancelRequested) {
        await api(`/api/jobs/${jobId}`,{method:'DELETE'});
        notice('Transcription cancelled.');
        finish();return;
      }
      let status;
      try {status=await api(`/api/jobs/${jobId}`);failures=0;}
      catch(error){if(++failures>3)throw error;await sleep(3000);continue;}
      $('stage').textContent=status.stage||'Transcribing video…';
      if(status.state==='processing') setRing('process-ring',0.65,'process-percent');
      if(status.state==='error') throw new Error(status.error);
      if(status.state==='cancelled') throw new Error('This transcription was cancelled.');
      if(status.state==='done') {
        const item={...status.result};
        await api(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{});
        setRing('process-ring',1,'process-percent');
        acceptResult(item);return;
      }
      await sleep(1000);
    }
    throw new Error('The reader is taking too long. Try a shorter video.');
  } catch(error) {
    if(jobId) await api(`/api/jobs/${jobId}`,{method:'DELETE'}).catch(()=>{});
    busy=false;jobId=null;
    $('busy').hidden=true;
    $('video-processing').hidden=true;
    $('result').hidden=true;
    $('empty-result').hidden=true;
    $('error-result').hidden=false;
    showTranscriptionError(error);
    $('result-tag').textContent='NEEDS ATTENTION';
    if(clip) $('new-video').hidden=false;
    notice('Transcription did not finish. Use Try again or record another video.');
    controls();resultControls();
  }
}
$('retry').onclick=()=>{
  $('error-result').hidden=true;
  void transcribeClip();
};
$('compatibility-retry').onclick=async()=>{
  $('error-result').hidden=true;
  notice('Switching to CPU/WASM compatibility mode and retrying this video…');
  try {
    const runtime=await import('./local-vsr.js');
    runtime.enableCompatibilityMode();
    await transcribeClip();
  } catch(error) {
    showTranscriptionError(error);
    $('error-result').hidden=false;
  }
};
$('cancel').onclick=()=>{
  cancelRequested=true;
  $('stage').textContent=localReader?'Stopping after the current local step…':'Cancelling…';
};

$('text').oninput=()=>{
  if(selected)selected.edited=$('text').value;
  resultControls();renderHistory();
};
$('copy').onclick=async()=>{
  try {await navigator.clipboard.writeText($('text').value);notice('Copied to clipboard.');}
  catch {$('text').focus();$('text').select();notice('Text selected. Use your browser Copy command.');}
};
$('speak').onclick=()=>{
  if(!('speechSynthesis'in window)) return notice('Read aloud is not supported by this browser.');
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance($('text').value));
};
$('download').onclick=()=>{
  const url=URL.createObjectURL(new Blob([$('text').value],{type:'text/plain;charset=utf-8'}));
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download='video-transcript.txt';anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('clear').onclick=()=>{
  if(busy)return;
  history.length=0;selected=null;
  $('text').value='';$('original').textContent='';$('alternatives').replaceChildren();$('elapsed').textContent='';
  $('result-tag').textContent='WAITING FOR VIDEO';
  window.speechSynthesis?.cancel();
  $('result').hidden=true;$('error-result').hidden=true;$('empty-result').hidden=false;
  renderHistory();resultControls();notice('Session history cleared.');
};

window.addEventListener('pagehide',()=>{
  clearInterval(timer);
  if(recorder)recorder.onstop=null;
  stopCamera();
  if(previewURL)URL.revokeObjectURL(previewURL);
  window.speechSynthesis?.cancel();
});

connect();
