import test from 'node:test';
import assert from 'node:assert/strict';
import {endpointURL,wordCount,clock,videoType} from '../web/core.js';
test('reader addresses require HTTPS except loopback',()=>{assert.equal(endpointURL('http://localhost:8000/'),'http://localhost:8000');assert.equal(endpointURL('https://reader.example/api/'),'https://reader.example/api');for(const value of ['http://reader.example','https://key@reader.example','https://reader.example/?key=secret','javascript:alert(1)'])assert.throws(()=>endpointURL(value));});
test('transcript and clip formatting handles empty and multi-space content',()=>{assert.equal(wordCount('  hello\nworld '),2);assert.equal(wordCount(' '),0);assert.equal(clock(19.8),'0:19');assert.equal(videoType('CLIP.MOV'),'video/quicktime');assert.equal(videoType('file.txt'),'');});
