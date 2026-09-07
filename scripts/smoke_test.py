"""Real inference through a running reader; prints only actual model output."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video',type=Path)
    parser.add_argument('--url',default='http://localhost:8000')
    parser.add_argument('--mode',choices=['fast','balanced','accurate'],default='fast')
    args=parser.parse_args()
    headers={}
    if os.getenv('CAMERA_API_TOKEN'):
        headers['Authorization']='Bearer '+os.environ['CAMERA_API_TOKEN']
    def call(path,data=None,method=None,extra=None):
        request=urllib.request.Request(args.url.rstrip('/')+path,data=data,method=method,headers={**headers,**(extra or {})})
        with urllib.request.urlopen(request,timeout=70) as response:return json.load(response)
    health=call('/api/health')
    if health['status']!='ready':raise SystemExit(health['message'])
    mime={'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.avi':'video/x-msvideo'}.get(args.video.suffix.lower())
    if not mime:raise SystemExit('Unsupported extension')
    started=time.monotonic()
    key=call('/api/jobs?mode='+args.mode,args.video.read_bytes(),'POST',{'Content-Type':mime})['id']
    try:
        while time.monotonic()-started<1200:
            result=call('/api/jobs/'+key)
            if result['state']=='done':
                assert result['result']['modality']=='video' and result['result']['text'].strip()
                print(json.dumps({'result':result['result'],'total_seconds':round(time.monotonic()-started,2)},indent=2))
                break
            if result['state'] in ('error','cancelled'):raise SystemExit(result['error'] or result['state'])
            time.sleep(1)
        else:raise SystemExit('Timed out')
    finally:call('/api/jobs/'+key,method='DELETE')
