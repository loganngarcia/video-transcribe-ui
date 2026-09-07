import json
import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient
from server.app import create_app
from server.engine import VideoError
from server.media import normalize

class FakeEngine:
    device = 'test'
    def load(self): pass
    def close(self): pass
    def transcribe(self, path, mode):
        assert path.exists()
        return {'text': 'TEST WORDS', 'alternatives': [], 'modality': 'video', 'seconds': 0.1}

def ready(client):
    for _ in range(100):
        if client.get('/api/health').json()['status'] == 'ready': return
        time.sleep(.01)
    pytest.fail('Reader did not start')

def poll(client, key):
    for _ in range(200):
        data = client.get('/api/jobs/'+key).json()
        if data['state'] in ('done','error','cancelled'): return data
        time.sleep(.01)
    pytest.fail('Job did not finish')

@pytest.fixture
def clip(tmp_path):
    path = tmp_path/'input.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=160x120:r=30','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-threads','1','-c:a','aac',str(path)], check=True)
    return path

def test_audio_removed_and_fps_normalized(clip,tmp_path):
    target=tmp_path/'normalized.mp4'
    normalize(clip,target)
    meta=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(target)]))
    assert [s['codec_type'] for s in meta['streams']] == ['video']
    assert meta['streams'][0]['r_frame_rate']=='25/1'

def test_full_job_lifecycle_and_cleanup(clip,monkeypatch):
    paths=[]
    class Engine(FakeEngine):
        def transcribe(self,path,mode):
            paths.append(path)
            return super().transcribe(path,mode)
    with TestClient(create_app(Engine)) as client:
        ready(client)
        response=client.post('/api/jobs',content=clip.read_bytes(),headers={'Content-Type':'video/mp4'})
        assert response.status_code==202
        key=response.json()['id']
        result=poll(client,key)
        assert result['result']['text']=='TEST WORDS'
        assert not paths[0].parent.exists()
        assert client.delete('/api/jobs/'+key).status_code==200
        assert client.get('/api/jobs/'+key).json()['result'] is None

def test_invalid_inputs_and_origins():
    with TestClient(create_app(FakeEngine)) as client:
        ready(client)
        assert client.post('/api/jobs',content=b'x',headers={'Content-Type':'text/plain'}).status_code==415
        assert client.post('/api/jobs',content=b'',headers={'Content-Type':'video/mp4'}).status_code==400
        assert client.post('/api/jobs?mode=bogus',content=b'x').status_code==422
        assert client.get('/api/health',headers={'Origin':'https://evil.example'}).status_code==403
        assert client.get('/api/health',headers={'Host':'evil.example'}).status_code==400
        response=client.post('/api/jobs',content=b'not a video',headers={'Content-Type':'video/mp4'})
        assert poll(client,response.json()['id'])['state']=='error'

def test_public_auth(monkeypatch):
    monkeypatch.setenv('CAMERA_PUBLIC','1')
    monkeypatch.setenv('CAMERA_API_TOKEN','too-short')
    with pytest.raises(RuntimeError):create_app(FakeEngine)
    monkeypatch.setenv('CAMERA_API_TOKEN','x'*32)
    with TestClient(create_app(FakeEngine)) as client:
        assert client.get('/api/health').status_code==401
        response=client.get('/api/health',headers={'Authorization':'Bearer '+'x'*32,'Origin':'https://loganngarcia.github.io'})
        assert response.status_code==200
        assert response.headers['access-control-allow-origin']=='https://loganngarcia.github.io'
        assert response.headers['cache-control']=='no-store'

def test_queue_and_cancellation(clip):
    release=threading.Event()
    class Slow(FakeEngine):
        def transcribe(self,path,mode):
            release.wait(5)
            return super().transcribe(path,mode)
    with TestClient(create_app(Slow)) as client:
        ready(client)
        try:
            responses=[client.post('/api/jobs',content=clip.read_bytes(),headers={'Content-Type':'video/mp4'}) for _ in range(4)]
            assert [r.status_code for r in responses]==[202,202,202,429]
            key=responses[1].json()['id']
            client.delete('/api/jobs/'+key)
            assert poll(client,key)['state']=='cancelled'
        finally: release.set()

def test_size_limit(monkeypatch):
    monkeypatch.setattr('server.app.LIMIT',4)
    with TestClient(create_app(FakeEngine)) as client:
        ready(client)
        assert client.post('/api/jobs',content=b'12345',headers={'Content-Type':'video/mp4'}).status_code==413
