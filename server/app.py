"""Single-process inference service. Never start multiple workers per model."""
import asyncio
import hmac
import logging
import os
import secrets
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .engine import USREngine, VideoError
from .media import normalize

LIMIT = 50 * 1024 * 1024

def create_app(engine_factory=USREngine):
    token = os.getenv('CAMERA_API_TOKEN', '')
    public = os.getenv('CAMERA_PUBLIC') == '1'
    if public and len(token) < 24:
        raise RuntimeError('Public servers require CAMERA_API_TOKEN of at least 24 characters.')
    origins = os.getenv('CAMERA_ORIGINS', 'https://loganngarcia.github.io,http://localhost:8000,http://127.0.0.1:8000').split(',')
    jobs, tasks = {}, set()
    engine = engine_factory()
    pool = ThreadPoolExecutor(max_workers=1)
    state = {'status': 'loading', 'message': 'Loading the reader. This can take several minutes.'}
    active = 0

    async def load():
        try:
            await asyncio.get_running_loop().run_in_executor(pool, engine.load)
            state.update(status='ready', message='Ready to read your clip.')
        except Exception:
            logging.exception('Model startup failed')
            state.update(status='unavailable', message='Reader unavailable. Check the server setup and logs.')

    async def expire():
        while True:
            await asyncio.sleep(30)
            for key, job in list(jobs.items()):
                if job['state'] in ('done', 'error', 'cancelled') and time.monotonic()-job['updated'] > 300:
                    jobs.pop(key, None)

    @asynccontextmanager
    async def lifespan(app):
        startup = asyncio.create_task(load())
        cleanup = asyncio.create_task(expire())
        yield
        cleanup.cancel()
        await startup
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.get_running_loop().run_in_executor(pool, engine.close)
        pool.shutdown()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type'])
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=os.getenv('CAMERA_HOSTS', '*' if public else 'localhost,127.0.0.1,testserver').split(','))

    @app.middleware('http')
    async def guard(request, call_next):
        origin = request.headers.get('origin')
        if origin and origin not in origins and origin != str(request.base_url).rstrip('/'):
            return JSONResponse({'detail': 'Origin not allowed.'}, 403)
        if request.url.path.startswith('/api/') and request.method != 'OPTIONS':
            if token:
                if not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {token}'):
                    return JSONResponse({'detail': 'Enter the correct connection key in Settings.'}, 401)
            elif request.client and request.client.host not in ('127.0.0.1', '::1', 'testclient'):
                return JSONResponse({'detail': 'Remote access requires a server connection key.'}, 403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = 'microphone=()'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/api/health')
    async def health():
        return {**state, 'version': 1, 'modality': 'video', 'model': 'USR 2.0', 'device': getattr(engine, 'device', 'unknown'), 'max_seconds': 20, 'max_bytes': LIMIT}

    async def execute(job):
        nonlocal active
        def work():
            if job['state'] == 'cancelled':
                return
            job.update(state='processing', stage='Preparing video')
            normalized = job['directory'] / 'normalized.mp4'
            normalize(job['directory'] / 'upload', normalized)
            if job['state'] == 'cancelled':
                return
            job['stage'] = 'Reading your words'
            result = engine.transcribe(normalized, job['mode'])
            if job['state'] != 'cancelled':
                job.update(state='done', result=result)
        try:
            await asyncio.get_running_loop().run_in_executor(pool, work)
        except VideoError as error:
            if job['state'] != 'cancelled':
                job.update(state='error', error=str(error))
        except Exception:
            logging.exception('Inference failed')
            if job['state'] != 'cancelled':
                job.update(state='error', error='The reader could not finish this clip. Try a shorter recording.')
        finally:
            shutil.rmtree(job['directory'], ignore_errors=True)
            job['updated'] = time.monotonic()
            active -= 1

    @app.post('/api/jobs', status_code=202)
    async def submit(request: Request, mode: str = 'balanced'):
        nonlocal active
        if state['status'] != 'ready':
            raise HTTPException(503, state['message'])
        if mode not in ('fast', 'balanced', 'accurate'):
            raise HTTPException(422, 'Unknown reading mode.')
        if request.headers.get('content-type', '').split(';')[0] not in ('video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'):
            raise HTTPException(415, 'Upload MP4, MOV, WebM, or AVI video.')
        if active >= 3:
            raise HTTPException(429, 'The reader is busy. Please try again shortly.')
        active += 1
        directory = Path(tempfile.mkdtemp(prefix='camera-transcribe-'))
        try:
            size = 0
            async with asyncio.timeout(60):
                with (directory / 'upload').open('wb') as output:
                    async for chunk in request.stream():
                        size += len(chunk)
                        if size > LIMIT:
                            raise HTTPException(413, 'Choose a video under 50 MB.')
                        output.write(chunk)
            if size == 0:
                raise HTTPException(400, 'The video is empty.')
        except BaseException as error:
            active -= 1
            shutil.rmtree(directory, ignore_errors=True)
            if isinstance(error, TimeoutError):
                raise HTTPException(408, 'Upload timed out. Try a smaller clip.') from error
            raise
        for key in list(jobs):
            if len(jobs) < 100:
                break
            if jobs[key]['state'] in ('done', 'error', 'cancelled'):
                del jobs[key]
        key = secrets.token_urlsafe(24)
        job = {'state': 'queued', 'stage': 'Waiting for the reader', 'result': None, 'error': None, 'directory': directory, 'mode': mode, 'updated': time.monotonic()}
        jobs[key] = job
        task = asyncio.create_task(execute(job))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return {'id': key}

    @app.get('/api/jobs/{key}')
    async def status(key: str):
        if key not in jobs:
            raise HTTPException(404, 'This session has expired. Please try again.')
        return {k: jobs[key][k] for k in ('state', 'stage', 'result', 'error')}

    @app.delete('/api/jobs/{key}')
    async def cancel(key: str):
        if key not in jobs:
            raise HTTPException(404, 'Session not found.')
        jobs[key].update(state='cancelled', result=None, updated=time.monotonic())
        return {'state': 'cancelled'}

    app.mount('/', StaticFiles(directory=Path(__file__).resolve().parents[1] / 'web', html=True), name='web')
    return app

app = create_app()
