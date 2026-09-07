"""Start one persistent local reader and its web interface."""
import argparse
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    sys.path.insert(0, str(root))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=8000, type=int)
    args = parser.parse_args()
    if args.host not in ('127.0.0.1', 'localhost', '::1'):
        os.environ['CAMERA_PUBLIC'] = '1'
        if len(os.getenv('CAMERA_API_TOKEN', '')) < 24:
            parser.error('Remote hosting requires CAMERA_API_TOKEN of at least 24 characters.')
    import uvicorn
    uvicorn.run('server.app:app', host=args.host, port=args.port, workers=1)
