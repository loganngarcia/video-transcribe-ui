import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web/webgpu';

const MP_TO_68 = [
  162,234,93,58,172,136,149,148,152,377,378,365,397,288,323,454,389,
  70,63,105,66,107,336,296,334,293,301,168,197,5,4,75,97,2,326,305,
  33,160,158,133,153,144,362,385,387,263,373,380,
  61,39,37,0,267,269,291,321,314,17,84,91,78,82,13,312,308,317,14,87
];
const STABLE = [28,33,36,39,42,45,48,54];
const MODEL_ROOT = () => new URL('model/', document.baseURI);
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const DOWNLOAD_CONCURRENCY = 4;

let metadataPromise;
let resourcesPromise;
let modelBufferPromise;
let sessionPromise;
let wasmSessionPromise;
let preloadPromise;
let activeProvider = null;

const clamp = (value,min=0,max=1) => Math.min(max,Math.max(min,value));
const emit = (cb, detail) => {
  cb?.(detail);
  window.dispatchEvent(new CustomEvent('camera-model-progress',{detail}));
};
const hardwareCores = () => Math.max(1,navigator.hardwareConcurrency || 2);
const deviceMemory = () => navigator.deviceMemory || 4;
const forceWasm = () => {
  try { return localStorage.getItem('video-transcribe-force-wasm') === '1'; } catch { return false; }
};
const canUseWebGPU = () => !!navigator.gpu && !forceWasm();
const providerName = () => activeProvider || (canUseWebGPU() ? 'WebGPU' : 'WASM');
const rememberWasmFallback = () => {
  try { localStorage.setItem('video-transcribe-force-wasm','1'); } catch {}
};

function previousNumber(key) {
  try {
    const value=Number(localStorage.getItem(key));
    return Number.isFinite(value)&&value>0 ? value : 0;
  } catch { return 0; }
}
function saveNumber(key,value) {
  try { localStorage.setItem(key,String(Math.round(value))); } catch {}
}
function compileEstimateMs() {
  const previous=previousNumber('camera-model-compile-ms');
  if(previous) return previous;
  const coreFactor=Math.sqrt(4/hardwareCores());
  const memoryFactor=deviceMemory()<4 ? 1.35 : 1;
  return (canUseWebGPU() ? 5500 : 10500)*coreFactor*memoryFactor;
}
function inferenceEstimateMs(frames) {
  const previous=previousNumber('camera-vsr-ms-per-frame');
  if(previous) return previous*frames;
  const cores=hardwareCores();
  const memoryFactor=deviceMemory()<4 ? 1.3 : 1;
  const perFrame=(canUseWebGPU() ? 24 : Math.max(45,95*(4/Math.min(8,cores))))*memoryFactor;
  return 800+perFrame*frames;
}
function initialNetworkBps() {
  const downlink=navigator.connection?.downlink;
  return downlink ? Math.max(250000,downlink*125000) : 2500000;
}
function etaTextSeconds(ms) {
  return Math.max(1,Math.round(ms/1000));
}

async function json(name) {
  const response=await fetch(new URL(name,MODEL_ROOT()),{cache:'force-cache'});
  if(!response.ok) throw new Error(`Browser model file missing: ${name}`);
  return response.json();
}

function metadata() {
  if(!metadataPromise) metadataPromise=Promise.all([
    json('manifest.json'),
    json('tokens.json'),
    json('mean-face.json'),
  ]).then(([manifest,tokens,meanFace])=>({manifest,tokens,meanFace}));
  return metadataPromise;
}

async function buildFaceTracker() {
  const vision=await FilesetResolver.forVisionTasks(VISION_WASM);
  return FaceLandmarker.createFromOptions(vision,{
    // Explicit CPU delegate avoids browser WebGL texture failures such as
    // "activeTexture" on otherwise-supported Chrome/Edge configurations.
    baseOptions:{modelAssetPath:FACE_MODEL,delegate:'CPU'},
    runningMode:'IMAGE',
    numFaces:1,
    minFaceDetectionConfidence:0.5,
    minFacePresenceConfidence:0.5,
  });
}

function resources() {
  if(!resourcesPromise) resourcesPromise=(async()=>{
    const [{manifest,tokens,meanFace},landmarker]=await Promise.all([
      metadata(),
      buildFaceTracker(),
    ]);
    return {manifest,tokens,meanFace,landmarker};
  })();
  return resourcesPromise;
}

function downloadModel(manifest,status) {
  if(modelBufferPromise) return modelBufferPromise;
  modelBufferPromise=(async()=>{
    const total=manifest.onnx_bytes;
    const buffer=new Uint8Array(total);
    const offsets=[];
    let running=0;
    for(const part of manifest.parts){offsets.push(running);running+=part.bytes;}
    if(running!==total) throw new Error('Browser model manifest size does not match its parts.');

    const started=performance.now();
    let loaded=0;
    let cursor=0;
    let smoothedBps=initialNetworkBps();
    let lastLoaded=0;
    let lastAt=started;

    const update=(stage='Downloading speech model…')=>{
      const now=performance.now();
      const elapsed=Math.max(1,now-started);
      const average=(loaded*1000)/elapsed;
      if(now-lastAt>500){
        const instant=((loaded-lastLoaded)*1000)/Math.max(1,now-lastAt);
        if(instant>0) smoothedBps=smoothedBps*0.7+instant*0.3;
        lastLoaded=loaded;lastAt=now;
      }
      const speed=loaded>512*1024 ? Math.max(average*0.55,smoothedBps*0.45) : smoothedBps;
      const remaining=Math.max(0,total-loaded);
      const etaMs=(remaining/Math.max(1,speed))*1000+compileEstimateMs();
      emit(status,{
        phase:'setup',
        stage,
        progress:clamp(0.03+0.79*(loaded/total)),
        etaSeconds:etaTextSeconds(etaMs),
        bytesLoaded:loaded,
        bytesTotal:total,
        speedBps:speed,
        provider:providerName(),
      });
    };

    update();
    const fetchPart=async index=>{
      const part=manifest.parts[index];
      const response=await fetch(new URL(part.file,MODEL_ROOT()),{cache:'force-cache'});
      if(!response.ok) throw new Error(`Could not download model part ${index+1}.`);
      let position=offsets[index];
      let partLoaded=0;
      if(response.body?.getReader){
        const reader=response.body.getReader();
        while(true){
          const {done,value}=await reader.read();
          if(done) break;
          buffer.set(value,position);
          position+=value.byteLength;
          partLoaded+=value.byteLength;
          loaded+=value.byteLength;
          update();
        }
      } else {
        const bytes=new Uint8Array(await response.arrayBuffer());
        buffer.set(bytes,position);
        partLoaded=bytes.byteLength;
        loaded+=bytes.byteLength;
        update();
      }
      if(partLoaded!==part.bytes) throw new Error(`Model part ${index+1} was incomplete.`);
    };

    const worker=async()=>{
      while(true){
        const index=cursor++;
        if(index>=manifest.parts.length) return;
        await fetchPart(index);
      }
    };
    await Promise.all(Array.from({length:Math.min(DOWNLOAD_CONCURRENCY,manifest.parts.length)},worker));
    if(loaded!==total) throw new Error('The browser model download was incomplete.');
    emit(status,{
      phase:'setup',
      stage:'Model downloaded. Starting it on this device…',
      progress:0.84,
      etaSeconds:etaTextSeconds(compileEstimateMs()),
      bytesLoaded:total,
      bytesTotal:total,
      speedBps:loaded*1000/Math.max(1,performance.now()-started),
      provider:providerName(),
    });
    return buffer;
  })();
  return modelBufferPromise;
}

async function createInferenceSession(manifest,status,provider) {
  ort.env.wasm.numThreads=Math.max(1,Math.min(4,hardwareCores()));
  const buffer=await downloadModel(manifest,status);
  const started=performance.now();
  activeProvider=provider;
  emit(status,{phase:'setup',stage:`Optimizing for ${provider}…`,progress:0.86,etaSeconds:etaTextSeconds(compileEstimateMs()),provider});
  const session=await ort.InferenceSession.create(buffer,{
    executionProviders:provider==='WebGPU'?['webgpu']:['wasm'],
    graphOptimizationLevel:'all',
    enableGraphCapture:false,
  });
  const created=performance.now();
  emit(status,{phase:'setup',stage:'Checking transcription engine…',progress:0.96,etaSeconds:2,provider});
  const warmup=new ort.Tensor('float32',new Float32Array(12*88*88),[1,12,88,88]);
  await session.run({video:warmup});
  saveNumber('camera-model-compile-ms',performance.now()-started);
  saveNumber('camera-model-session-ms',created-started);
  return session;
}

function wasmSession(manifest,status) {
  if(!wasmSessionPromise) wasmSessionPromise=createInferenceSession(manifest,status,'WASM');
  return wasmSessionPromise;
}

function modelSession(manifest,status) {
  if(sessionPromise) return sessionPromise;
  sessionPromise=(async()=>{
    if(!canUseWebGPU()) return wasmSession(manifest,status);
    try {
      return await createInferenceSession(manifest,status,'WebGPU');
    } catch(error) {
      console.warn('WebGPU initialization failed; switching Video Transcribe to WASM.',error);
      rememberWasmFallback();
      emit(status,{phase:'setup',stage:'Graphics acceleration unavailable. Switching to compatibility mode…',progress:0.95,etaSeconds:etaTextSeconds(compileEstimateMs()),provider:'WASM'});
      return wasmSession(manifest,status);
    }
  })();
  return sessionPromise;
}

async function runInferenceWithFallback(manifest,input,status) {
  let session=await modelSession(manifest,status);
  try {
    return {output:await session.run({video:input}),provider:activeProvider||providerName()};
  } catch(error) {
    if((activeProvider||providerName())!=='WebGPU') throw error;
    console.warn('WebGPU inference failed; retrying with WASM.',error);
    rememberWasmFallback();
    emit(status,{phase:'processing',stage:'Graphics acceleration stopped. Retrying safely…',progress:0.72,etaSeconds:etaTextSeconds(compileEstimateMs()),provider:'WASM'});
    session=await wasmSession(manifest,status);
    const output=await session.run({video:input});
    return {output,provider:'WASM'};
  }
}

export function enableCompatibilityMode() {
  rememberWasmFallback();
  activeProvider=wasmSessionPromise?'WASM':null;
  sessionPromise=wasmSessionPromise || null;
  preloadPromise=null;
}

export async function browserModelAvailable() {
  try {
    const response=await fetch(new URL('manifest.json',MODEL_ROOT()),{method:'HEAD',cache:'no-cache'});
    return response.ok;
  } catch { return false; }
}

export function preloadLocalModel(status) {
  if(preloadPromise) return preloadPromise;
  preloadPromise=(async()=>{
    emit(status,{phase:'setup',stage:'Preparing on-device transcription…',progress:0.01,etaSeconds:Math.ceil((225*1024*1024/initialNetworkBps()+compileEstimateMs()/1000)),provider:providerName()});
    const meta=await metadata();
    const [resourceSet,session]=await Promise.all([
      resources(),
      modelSession(meta.manifest,status),
    ]);
    emit(status,{phase:'setup',stage:'Ready to transcribe',progress:1,etaSeconds:0,ready:true,provider:providerName()});
    return {resources:resourceSet,session};
  })().catch(error=>{
    emit(status,{phase:'setup',stage:'Could not prepare on-device transcription',progress:0,etaSeconds:null,error:error.message});
    preloadPromise=null;
    throw error;
  });
  return preloadPromise;
}

function similarity(src,dst) {
  let sx=0,sy=0,dx=0,dy=0;
  for(let i=0;i<src.length;i++){sx+=src[i][0];sy+=src[i][1];dx+=dst[i][0];dy+=dst[i][1];}
  sx/=src.length;sy/=src.length;dx/=dst.length;dy/=dst.length;
  let dot=0,cross=0,norm=0;
  for(let i=0;i<src.length;i++){
    const x=src[i][0]-sx,y=src[i][1]-sy,u=dst[i][0]-dx,v=dst[i][1]-dy;
    dot+=x*u+y*v;cross+=x*v-y*u;norm+=x*x+y*y;
  }
  if(norm<1e-8) return null;
  const a=dot/norm,b=cross/norm;
  return {a,b,tx:dx-a*sx+b*sy,ty:dy-b*sx-a*sy};
}
function transformPoint(p,m){return [m.a*p[0]-m.b*p[1]+m.tx,m.b*p[0]+m.a*p[1]+m.ty];}

function mouthFrame(video,landmarks,meanFace,canvas,ctx) {
  const mapped=MP_TO_68.map(index=>{
    const p=landmarks[index];
    return [p.x*video.videoWidth,p.y*video.videoHeight];
  });
  const m=similarity(STABLE.map(i=>mapped[i]),STABLE.map(i=>meanFace[i]));
  if(!m) return null;
  canvas.width=256;canvas.height=256;
  ctx.setTransform(m.a,m.b,-m.b,m.a,m.tx,m.ty);
  ctx.drawImage(video,0,0);
  ctx.setTransform(1,0,0,1,0,0);
  const lips=mapped.slice(48,68).map(p=>transformPoint(p,m));
  const cx=lips.reduce((v,p)=>v+p[0],0)/lips.length;
  const cy=lips.reduce((v,p)=>v+p[1],0)/lips.length;
  let image;
  try {image=ctx.getImageData(Math.round(cx-48)+4,Math.round(cy-48)+4,88,88);} catch {return null;}
  const out=new Float32Array(88*88);
  for(let i=0,j=0;i<image.data.length;i+=4,j++){
    const gray=(0.2989*image.data[i]+0.5870*image.data[i+1]+0.1140*image.data[i+2])/255;
    out[j]=(gray-0.421)/0.165;
  }
  return out;
}

async function seek(video,time) {
  if(Math.abs(video.currentTime-time)<0.0005) return;
  await new Promise((resolve,reject)=>{
    const done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(new Error('Could not decode this video locally.'));};
    const cleanup=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};
    video.addEventListener('seeked',done,{once:true});
    video.addEventListener('error',fail,{once:true});
    video.currentTime=time;
  });
}

export async function startLiveMouthCapture(video) {
  const prepared=await preloadLocalModel();
  const {landmarker,meanFace}=prepared.resources;
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const frames=[];
  let found=0;
  let attempted=0;
  let last=null;
  let running=true;
  let raf=0;
  let captureError=null;
  let nextAt=performance.now();

  const captureFrame=()=>{
    if(!running) return;
    const now=performance.now();
    if(now>=nextAt && attempted<500 && video.readyState>=2 && video.videoWidth>0) {
      nextAt+=40;
      attempted++;
      try {
        const result=landmarker.detect(video);
        const face=result.faceLandmarks?.[0];
        let frame=null;
        if(face) {
          frame=mouthFrame(video,face,meanFace,canvas,ctx);
          if(frame) found++;
        }
        if(!frame && last) frame=last.slice();
        if(frame) {
          frames.push(frame);
          last=frame;
        }
      } catch(error) {
        captureError=error;
        running=false;
      }
    }
    if(running) raf=requestAnimationFrame(captureFrame);
  };

  raf=requestAnimationFrame(captureFrame);

  return {
    stop() {
      running=false;
      if(raf) cancelAnimationFrame(raf);
      if(captureError) throw captureError;
      if(attempted<12 || frames.length<12) {
        throw new Error('The camera recording was too short to read. Record at least half a second.');
      }
      const coverage=found/attempted;
      if(coverage<0.6) {
        throw new Error('Your face was not clearly visible for enough of the recording. Keep your whole face in view and try again.');
      }
      while(frames.length<attempted && last) frames.push(last.slice());
      const count=frames.length;
      const tensor=new Float32Array(count*88*88);
      frames.forEach((frame,index)=>tensor.set(frame,index*88*88));
      return {tensor,count,coverage,source:'live-camera'};
    },
    cancel() {
      running=false;
      if(raf) cancelAnimationFrame(raf);
    }
  };
}

async function extract(blob,landmarker,meanFace,status) {
  const video=document.createElement('video');
  video.muted=true;video.playsInline=true;video.preload='auto';
  const url=URL.createObjectURL(blob);video.src=url;
  try {
    await new Promise((resolve,reject)=>{
      video.onloadedmetadata=resolve;
      video.onerror=()=>reject(new Error('This browser could not decode the clip.'));
    });
    const duration=Math.min(20,video.duration);
    if(!Number.isFinite(duration)||duration<0.4) throw new Error('Choose a clip between half a second and 20 seconds.');
    const count=Math.max(12,Math.min(500,Math.floor(duration*25)));
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
    const frames=[];let found=0,last=null;
    const started=performance.now();
    for(let i=0;i<count;i++){
      await seek(video,Math.min(duration-0.001,i/25));
      let result;
      try {
        result=landmarker.detect(video);
      } catch(error) {
        const message=String(error?.message||error);
        if(/activeTexture|webgl|texture|gpu/i.test(message)) {
          throw new Error('Your browser graphics path failed while tracking the face. Video Transcribe now uses CPU face tracking; refresh once to load the compatibility fix.');
        }
        throw error;
      }
      const face=result.faceLandmarks?.[0];
      let frame=null;
      if(face){frame=mouthFrame(video,face,meanFace,canvas,ctx);if(frame)found++;}
      if(!frame&&last) frame=last.slice();
      if(frame){frames.push(frame);last=frame;}
      const elapsed=performance.now()-started;
      const perFrame=elapsed/(i+1);
      const remainingFrames=count-i-1;
      const etaMs=remainingFrames*perFrame+inferenceEstimateMs(count);
      emit(status,{
        phase:'processing',
        stage:`Analyzing video · ${Math.round(((i+1)/count)*100)}%`,
        progress:0.05+0.58*((i+1)/count),
        etaSeconds:etaTextSeconds(etaMs),
      });
      if(i%8===0) await new Promise(requestAnimationFrame);
    }
    if(found/count<0.6) throw new Error('Keep one face clearly visible, facing the camera, in good light.');
    if(frames.length<12) throw new Error('Could not track your mouth for enough of the clip.');
    while(frames.length<count) frames.push(last.slice());
    const tensor=new Float32Array(count*88*88);
    frames.forEach((frame,i)=>tensor.set(frame,i*88*88));
    return {tensor,count,coverage:found/count};
  } finally {
    video.removeAttribute('src');video.load();URL.revokeObjectURL(url);
  }
}

function greedyCTC(output,tokens) {
  const dims=output.dims;
  const frames=dims[dims.length-2],vocab=dims[dims.length-1],data=output.data;
  const ids=[];let previous=-1;
  for(let t=0;t<frames;t++){
    let best=0,bestValue=-Infinity,offset=t*vocab;
    for(let v=0;v<vocab;v++){const value=Number(data[offset+v]);if(value>bestValue){bestValue=value;best=v;}}
    if(best!==previous&&best!==0&&best!==tokens.length-1) ids.push(best);
    previous=best;
  }
  return ids.map(id=>tokens[id]||'').join('').replaceAll('▁',' ').replaceAll('<space>',' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}

export async function transcribeLocally(blob,status,preparedFrames=null) {
  const started=performance.now();
  emit(status,{phase:'processing',stage:'Getting transcription ready…',progress:0.01,etaSeconds:null});
  const prepared=await preloadLocalModel(status);
  const {manifest,tokens,meanFace,landmarker}=prepared.resources;
  const frameData=preparedFrames || await extract(blob,landmarker,meanFace,status);
  const {tensor,count,coverage}=frameData;
  if(preparedFrames) {
    emit(status,{phase:'processing',stage:'Camera frames ready · starting transcription…',progress:0.63,etaSeconds:etaTextSeconds(inferenceEstimateMs(count))});
  }
  const inferenceEstimate=inferenceEstimateMs(count);
  emit(status,{phase:'processing',stage:'Transcribing video…',progress:0.66,etaSeconds:etaTextSeconds(inferenceEstimate),provider:providerName()});
  const inferenceStarted=performance.now();
  const input=new ort.Tensor('float32',tensor,[1,count,88,88]);
  const inference=await runInferenceWithFallback(manifest,input,status);
  const output=inference.output;
  activeProvider=inference.provider;
  const inferenceMs=performance.now()-inferenceStarted;
  saveNumber('camera-vsr-ms-per-frame',inferenceMs/count);
  emit(status,{phase:'processing',stage:'Finishing transcript…',progress:0.96,etaSeconds:1});
  const logits=output.logits||Object.values(output)[0];
  if(!logits) throw new Error('The transcription engine returned no output.');
  const text=greedyCTC(logits,tokens);
  if(!text) throw new Error('No words recognized. Try a short, clear sentence in good light.');
  emit(status,{phase:'processing',stage:'Transcript ready',progress:1,etaSeconds:0,ready:true});
  return {
    text,
    alternatives:[],
    seconds:Math.round((performance.now()-started)/10)/100,
    face_coverage:Math.round(coverage*100)/100,
    modality:'video',
    model:'USR 2.0 Base+ · on-device CTC',
    mode:activeProvider||providerName(),
    local:true,
    input_source:preparedFrames?'live-camera':'decoded-video',
    model_revision:manifest.revision,
  };
}
