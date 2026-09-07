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

let resourcesPromise;
let sessionPromise;

const emit = (cb, stage, progress) => cb?.({stage, progress});

async function json(name) {
  const response = await fetch(new URL(name, MODEL_ROOT()), {cache:'force-cache'});
  if (!response.ok) throw new Error(`Browser model file missing: ${name}`);
  return response.json();
}

export async function browserModelAvailable() {
  try {
    const response = await fetch(new URL('manifest.json', MODEL_ROOT()), {method:'HEAD', cache:'no-cache'});
    return response.ok;
  } catch {
    return false;
  }
}

async function resources(status) {
  if (!resourcesPromise) resourcesPromise = (async () => {
    emit(status, 'Loading face tracker…', 0.02);
    const [manifest,tokens,meanFace,vision] = await Promise.all([
      json('manifest.json'),
      json('tokens.json'),
      json('mean-face.json'),
      FilesetResolver.forVisionTasks(VISION_WASM),
    ]);
    const landmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions:{modelAssetPath:FACE_MODEL},
      runningMode:'IMAGE',
      numFaces:1,
      minFaceDetectionConfidence:0.5,
      minFacePresenceConfidence:0.5,
    });
    return {manifest,tokens,meanFace,landmarker};
  })();
  return resourcesPromise;
}

async function modelSession(manifest,status) {
  if (!sessionPromise) sessionPromise = (async () => {
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    emit(status, `Downloading on-device USR model (0/${manifest.parts.length})…`, 0.08);
    const buffer = new Uint8Array(manifest.onnx_bytes);
    let offset=0;
    for (let i=0;i<manifest.parts.length;i++) {
      const part=manifest.parts[i];
      const response=await fetch(new URL(part.file,MODEL_ROOT()),{cache:'force-cache'});
      if(!response.ok) throw new Error(`Could not download model part ${i+1}.`);
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength!==part.bytes) throw new Error(`Model part ${i+1} was incomplete.`);
      buffer.set(bytes,offset); offset+=bytes.byteLength;
      emit(status,`Downloading on-device USR model (${i+1}/${manifest.parts.length})…`,0.08+0.30*((i+1)/manifest.parts.length));
      await new Promise(requestAnimationFrame);
    }
    if(offset!==manifest.onnx_bytes) throw new Error('The browser model download was incomplete.');
    emit(status,'Starting USR on this device…',0.4);
    const providers = navigator.gpu ? ['webgpu','wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: providers,
      graphOptimizationLevel:'all',
      enableGraphCapture:false,
    });
    return session;
  })();
  return sessionPromise;
}

function similarity(src,dst) {
  let sx=0,sy=0,dx=0,dy=0;
  for(let i=0;i<src.length;i++){sx+=src[i][0];sy+=src[i][1];dx+=dst[i][0];dy+=dst[i][1];}
  sx/=src.length; sy/=src.length; dx/=dst.length; dy/=dst.length;
  let dot=0,cross=0,norm=0;
  for(let i=0;i<src.length;i++){
    const x=src[i][0]-sx,y=src[i][1]-sy,u=dst[i][0]-dx,v=dst[i][1]-dy;
    dot+=x*u+y*v; cross+=x*v-y*u; norm+=x*x+y*y;
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
  const src=STABLE.map(i=>mapped[i]), dst=STABLE.map(i=>meanFace[i]);
  const m=similarity(src,dst);
  if(!m) return null;
  canvas.width=256;canvas.height=256;
  ctx.setTransform(m.a,m.b,-m.b,m.a,m.tx,m.ty);
  ctx.drawImage(video,0,0);
  ctx.setTransform(1,0,0,1,0,0);
  const lips=mapped.slice(48,68).map(p=>transformPoint(p,m));
  const cx=lips.reduce((v,p)=>v+p[0],0)/lips.length;
  const cy=lips.reduce((v,p)=>v+p[1],0)/lips.length;
  const x=Math.round(cx-48)+4,y=Math.round(cy-48)+4;
  let image;
  try { image=ctx.getImageData(x,y,88,88); } catch { return null; }
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
    const done=()=>{cleanup();resolve();}, fail=()=>{cleanup();reject(new Error('Could not decode this video locally.'));};
    const cleanup=()=>{video.removeEventListener('seeked',done);video.removeEventListener('error',fail);};
    video.addEventListener('seeked',done,{once:true}); video.addEventListener('error',fail,{once:true});
    video.currentTime=time;
  });
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
    for(let i=0;i<count;i++){
      await seek(video,Math.min(duration-0.001,i/25));
      const result=landmarker.detect(video);
      const face=result.faceLandmarks?.[0];
      let frame=null;
      if(face){frame=mouthFrame(video,face,meanFace,canvas,ctx);if(frame)found++;}
      if(!frame && last) frame=last.slice();
      if(frame){frames.push(frame);last=frame;}
      emit(status,`Finding your lips… ${i+1}/${count}`,0.42+0.30*((i+1)/count));
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
  const frames=dims[dims.length-2], vocab=dims[dims.length-1];
  const data=output.data;
  const ids=[];let previous=-1;
  for(let t=0;t<frames;t++){
    let best=0,bestValue=-Infinity;
    const offset=t*vocab;
    for(let v=0;v<vocab;v++){const value=Number(data[offset+v]);if(value>bestValue){bestValue=value;best=v;}}
    if(best!==previous && best!==0 && best!==tokens.length-1) ids.push(best);
    previous=best;
  }
  let text=ids.map(id=>tokens[id]||'').join('');
  text=text.replaceAll('▁',' ').replaceAll('<space>',' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  return text;
}

export async function transcribeLocally(blob,status) {
  const started=performance.now();
  const {manifest,tokens,meanFace,landmarker}=await resources(status);
  const session=await modelSession(manifest,status);
  const {tensor,count,coverage}=await extract(blob,landmarker,meanFace,status);
  emit(status,'Reading your words on this device…',0.76);
  const input=new ort.Tensor('float32',tensor,[1,count,88,88]);
  const output=await session.run({video:input});
  const logits=output.logits || output[session.outputNames[0]];
  const text=greedyCTC(logits,tokens);
  if(!text) throw new Error('No words recognized. Try a short, clear sentence in good light.');
  emit(status,'Done',1);
  return {
    text,
    alternatives:[],
    seconds:Math.round((performance.now()-started)/10)/100,
    face_coverage:Math.round(coverage*100)/100,
    modality:'video',
    model:'USR 2.0 Base+ · on-device CTC',
    mode:navigator.gpu?'WebGPU':'WASM',
    local:true,
  };
}
