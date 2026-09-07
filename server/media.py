"""Bounded local decoding. Audio is removed before model inference."""
import json
import subprocess
from .engine import VideoError

INPUT = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi']

def normalize(source, target):
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', *INPUT, '-show_streams', '-show_format', '-of', 'json', str(source)], capture_output=True, timeout=15, check=True)
        meta = json.loads(probe.stdout)
        videos = [s for s in meta['streams'] if s['codec_type'] == 'video']
        if len(videos) != 1 or videos[0].get('width', 0) * videos[0].get('height', 0) > 3840*2160:
            raise VideoError('Choose a video with one video track, up to 4K resolution.')
        duration = float(meta.get('format', {}).get('duration', 0))
        if duration > 20.3 or (duration and duration < 0.4):
            raise VideoError('Choose a clip between half a second and 20 seconds.')
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-threads', '2', *INPUT, '-i', str(source), '-map', '0:v:0', '-an', '-sn', '-dn', '-t', '20.04', '-vf', "fps=25,scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-threads', '2', str(target)], capture_output=True, timeout=45, check=True)
    except (subprocess.SubprocessError, KeyError, json.JSONDecodeError, ValueError) as error:
        if isinstance(error, VideoError):
            raise
        raise VideoError('This video could not be read. Try MP4 or WebM.') from error
