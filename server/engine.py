"""Persistent video-only adapter for the pinned, unmodified USR 2.0 release."""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class VideoError(ValueError):
    pass

class USREngine:
    def load(self):
        import torch
        from hydra import compose, initialize_config_dir
        self.torch = torch
        torch.set_num_threads(max(1, min(8, int(os.getenv('TORCH_THREADS', '4')))))
        source = Path(os.getenv('USR2_ROOT', ROOT / 'vendor/usr2')).resolve()
        checkpoint = Path(os.getenv('USR2_CHECKPOINT', ROOT / 'models/usr2-huge.pth'))
        if not checkpoint.is_file():
            raise RuntimeError('Model missing. Run python scripts/setup_model.py first.')
        sys.path.insert(0, str(source))
        import demo
        self.demo = demo
        self.size = os.getenv('USR2_SIZE', 'huge')
        if self.size not in ('huge', 'baseplus'):
            raise ValueError('USR2_SIZE must be huge or baseplus')
        with initialize_config_dir(config_dir=str(source / 'conf'), version_base='1.3'):
            self.cfg = compose(config_name='config', overrides=[f'model/backbone=resnet_transformer_{self.size}', 'modality=v'])
        self.device = os.getenv('USR2_DEVICE', 'cuda' if torch.cuda.is_available() else 'cpu')
        weights = torch.load(checkpoint, map_location='cpu', weights_only=True, mmap=True)
        weights = weights.get('state_dict', weights)
        weights = {k.removeprefix('_orig_mod.'): v for k, v in weights.items()}
        if any(k.startswith('model.backbone.') for k in weights):
            weights = {k.removeprefix('model.backbone.'): v for k, v in weights.items() if k.startswith('model.backbone.')}
        self.model = demo.E2E(len(demo.UNIGRAM1000_LIST), self.cfg.model.backbone)
        self.model.load_state_dict(weights, strict=True, assign=True)
        self.model.eval().to(self.device)
        self.detector = demo.LandmarksDetector(detector='mediapipe')
        self.processor = demo.VideoProcess(convert_gray=False)
        self.transform = demo.build_video_transform()
        self.beams = {}
        for name, beam, ctc in [('fast', 1, 0.0), ('balanced', 10, 0.1), ('accurate', 40, 0.1)]:
            self.cfg.decode.beam_size, self.cfg.decode.ctc_weight = beam, ctc
            self.beams[name] = demo.build_beam_search(self.cfg, self.model).to(self.device)

    def transcribe(self, path, mode):
        import cv2
        import numpy as np
        started = time.monotonic()
        capture = cv2.VideoCapture(str(path))
        frames = []
        try:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                if len(frames) > 500:
                    raise VideoError('Please use a clip of 20 seconds or less.')
        finally:
            capture.release()
        if len(frames) < 10:
            raise VideoError('Please record at least half a second.')
        frames = np.stack(frames)
        landmarks = self.detector(frames)
        coverage = sum(x is not None for x in landmarks) / len(landmarks)
        if coverage < 0.6:
            raise VideoError('Keep one face clearly visible, facing the camera, in good light.')
        mouth = self.processor(frames, landmarks)
        if mouth is None:
            raise VideoError('Could not track your mouth. Try a brighter, front-facing clip.')
        with self.torch.inference_mode():
            tensor = self.transform(self.torch.from_numpy(mouth).permute(3, 0, 1, 2).float())
            features = self.model.encoder(xs_v=tensor.unsqueeze(0).to(self.device))
            hypotheses = self.beams[mode](x=features.squeeze(0), modality='v', maxlenratio=self.cfg.decode.maxlenratio, minlenratio=self.cfg.decode.minlenratio)
        candidates = []
        for hypothesis in hypotheses[:3]:
            text, *_ = self.demo.parse_hypothesis(hypothesis.asdict(), self.demo.UNIGRAM1000_LIST)
            text = text.replace('<eos>', '').replace('▁', ' ').strip()
            if text and text not in candidates:
                candidates.append(text)
        if not candidates:
            raise VideoError('No words recognized. Try a short, clear sentence.')
        return {'text': candidates[0], 'alternatives': candidates[1:], 'seconds': round(time.monotonic()-started, 2), 'face_coverage': round(coverage, 2), 'modality': 'video', 'model': f'USR 2.0 {self.size}', 'mode': mode}

    def close(self):
        if hasattr(self, 'detector'):
            self.detector.close()
