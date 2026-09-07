"""Download the official noncommercial model; never commit weights to Git."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'df0c78b7a3807e625a0fcdadd14b1cf674d21c91'
IDS = {'huge': '1LzFOTYu45zCLOHGVLQt7pMGjw6jmmo9Y', 'baseplus': '18vmJjdem5XPOA8bmizybIW5sLJuHMdRR'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size', choices=IDS, default='huge')
    args = parser.parse_args()
    for executable in ('git', 'ffmpeg', 'ffprobe'):
        if not shutil.which(executable):
            parser.error(f'Install {executable} first. See README.md.')
    source = ROOT / 'vendor/usr2'
    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', 'clone', 'https://github.com/ahaliassos/usr2.git', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', REVISION], check=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != REVISION:
        parser.error('Existing vendor/usr2 differs from the tested revision. Move it aside before setup.')
    target = ROOT / f'models/usr2-{args.size}.pth'
    target.parent.mkdir(exist_ok=True)
    if not target.exists():
        import gdown
        partial = target.with_suffix('.partial')
        print('Downloading official USR 2.0 weights (CC BY-NC 4.0). Huge is approximately 7.6 GB.')
        result = gdown.download(id=IDS[args.size], output=str(partial), resume=True)
        if not result:
            raise RuntimeError('Download failed. Run setup again to resume.')
        if partial.stat().st_size < 100_000_000:
            raise RuntimeError('Download is unexpectedly small; not a valid model.')
        partial.replace(target)
    digest = hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()
    (target.parent / f'{args.size}-manifest.json').write_text(json.dumps({'upstream': 'https://github.com/ahaliassos/usr2', 'revision': revision, 'size': args.size, 'sha256': digest}, indent=2)+'\n')
    print(f'Model ready: {target}\nSHA256: {digest}')
    if args.size != 'huge':
        print('Set USR2_SIZE=baseplus and USR2_CHECKPOINT=models/usr2-baseplus.pth before starting.')

if __name__ == '__main__':
    main()
