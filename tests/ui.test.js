import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const core=fs.readFileSync(new URL('../web/core.js',import.meta.url),'utf8').replaceAll('export ','');
const app=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*?;\n/,'');
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
function setup() {
  const dom=new JSDOM(html,{url:'http://localhost:8000',runScripts:'outside-only'}), w=dom.window;
  const calls=[];let mediaRequest,stopped=0;
  const stream={getTracks:()=>[{stop:()=>stopped++}]};
  w.AbortSignal.timeout=()=>new w.AbortController().signal;
  w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
  w.HTMLMediaElement.prototype.play=async()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async request=>{mediaRequest=request;return stream;}}});
  w.MediaRecorder=class {
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.mimeType='video/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new w.Blob(['fixture'])});this.onstop?.();}
  };
  w.fetch=async(url,options={})=>{
    calls.push({url,options});
    const data=url.endsWith('/api/health') ? {status:'ready',version:1,modality:'video'} : options.method==='POST' ? {id:'fixture-id'} : options.method==='DELETE' ? {state:'cancelled'} : {state:'done',result:{text:'UNIT TEST TRANSCRIPT',alternatives:['UNIT TEST ALTERNATIVE'],seconds:1,modality:'video'}};
    return {ok:true,json:async()=>data};
  };
  vm.runInContext(core+'\n'+app,dom.getInternalVMContext());
  return {dom,w,calls,get mediaRequest(){return mediaRequest;},get stopped(){return stopped;}};
}
test('camera captures video without audio and stopping automatically transcribes',async()=>{
  const state=setup(),{w,dom}=state;
  try {
    await settle();w.document.getElementById('enable').click();await settle();
    assert.equal(state.mediaRequest.audio,false);
    const record=w.document.getElementById('record');assert.equal(record.disabled,false);
    record.click();assert.equal(record.textContent,'Stop & transcribe');record.click();
    assert.equal(w.document.getElementById('clip').hidden,false);
    assert.equal(w.document.getElementById('busy').hidden,false);
    assert.equal(w.document.getElementById('video-processing').hidden,false);
    assert.equal(w.document.getElementById('result-tag').textContent,'TRANSCRIBING NOW');
    assert.equal(w.document.getElementById('transcribe'),null);
    assert.ok(state.stopped>0);
    await settle();
    assert.equal(w.document.getElementById('text').value,'UNIT TEST TRANSCRIPT');
  } finally {dom.window.close();}
});
test('transcription uses real job protocol and clears retrieved server output',async()=>{
  const {w,dom,calls}=setup();
  try {
    await settle();w.document.getElementById('enable').click();await settle();
    w.document.getElementById('record').click();w.document.getElementById('record').click();await settle();
    assert.equal(w.document.getElementById('text').value,'UNIT TEST TRANSCRIPT');
    assert.ok(calls.some(c=>c.options.method==='DELETE'&&c.url.endsWith('/api/jobs/fixture-id')));
    assert.equal(w.document.getElementById('copy').disabled,false);
    w.document.getElementById('clear').click();assert.equal(w.document.getElementById('original').textContent,'');assert.equal(w.document.getElementById('text').value,'');
  } finally {dom.window.close();}
});
test('settings persist reader preferences but never connection keys',async()=>{
  const {w,dom}=setup();
  try {
    await settle();w.document.getElementById('settings-open').click();
    w.document.getElementById('endpoint').value='https://reader.example';w.document.getElementById('key').value='unit-test-key';
    w.document.getElementById('settings-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
    const stored=w.localStorage.getItem('camera-preferences');assert.ok(stored.includes('reader.example'));assert.ok(!stored.includes('unit-test-key'));
  } finally {dom.window.close();}
});
