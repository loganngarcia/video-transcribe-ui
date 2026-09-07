"""Export official USR 2.0 Base+ visual encoder + CTC head for browser inference.

This intentionally exports only the visual encoder and auxiliary CTC projection.
The browser performs greedy CTC collapse locally. It avoids the Python/ESPnet
autoregressive beam-search runtime while keeping the actual USR 2.0 visual model.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

REVISION = "df0c78b7a3807e625a0fcdadd14b1cf674d21c91"
BASEPLUS_ID = "18vmJjdem5XPOA8bmizybIW5sLJuHMdRR"
PART_BYTES = 48 * 1024 * 1024

def sha256(path: Path) -> str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda:f.read(8*1024*1024), b""):
            h.update(block)
    return h.hexdigest()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--output", default="browser-model")
    p.add_argument("--source", default="vendor/usr2-browser-export")
    args=p.parse_args()
    root=Path(__file__).resolve().parents[1]
    source=(root/args.source).resolve()
    out=(root/args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)

    if not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git","clone","--filter=blob:none","https://github.com/ahaliassos/usr2.git",str(source)],check=True)
    subprocess.run(["git","-C",str(source),"fetch","origin",REVISION,"--depth=1"],check=True)
    subprocess.run(["git","-C",str(source),"checkout","--force",REVISION],check=True)

    checkpoint=out/"usr2-baseplus.pth"
    if not checkpoint.exists():
        import gdown
        if not gdown.download(id=BASEPLUS_ID, output=str(checkpoint), quiet=False):
            raise RuntimeError("Official Base+ checkpoint download failed")

    sys.path.insert(0,str(source))
    import torch
    from espnet.nets.pytorch_backend.e2e_asr_transformer import E2E

    cfg=SimpleNamespace(
        idim=512, adim=768, aheads=12, eunits=3072, elayers=12,
        ddim=768, dheads=12, dunits=3072, dlayers=6,
        gamma_init=0.1, ctc_rel_weight=0.1,
    )
    model=E2E(1049,cfg)
    state=torch.load(checkpoint,map_location="cpu",weights_only=True,mmap=True)
    state=state.get("state_dict",state)
    if any(k.startswith("_orig_mod.") for k in state):
        state={k.removeprefix("_orig_mod."):v for k,v in state.items()}
    if any(k.startswith("model.backbone.") for k in state):
        state={k.removeprefix("model.backbone."):v for k,v in state.items() if k.startswith("model.backbone.")}
    missing,unexpected=model.load_state_dict(state,strict=False,assign=True)
    # Decoder/other CTC heads are not needed at inference but their weights should still exist upstream.
    if unexpected:
        raise RuntimeError(f"Unexpected checkpoint keys: {unexpected[:10]}")
    model.eval()

    class VisualCTC(torch.nn.Module):
        def __init__(self, base):
            super().__init__()
            self.encoder=base.encoder
            self.ctc=base.ctc_v.ctc_lo
        def forward(self, video):
            features=self.encoder(xs_v=video)
            return self.ctc(features)

    export=VisualCTC(model).eval()
    dummy=torch.zeros(1,100,88,88,dtype=torch.float32)
    raw=out/"usr2-baseplus-ctc-fp32.onnx"
    print("Exporting ONNX...", flush=True)
    torch.onnx.export(
        export,
        (dummy,),
        raw,
        input_names=["video"],
        output_names=["logits"],
        dynamic_axes={"video":{1:"frames"},"logits":{1:"frames"}},
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )

    import onnx
    from onnxconverter_common import float16
    graph=onnx.load(raw,load_external_data=True)
    print("Converting weights/operators to FP16...", flush=True)
    graph16=float16.convert_float_to_float16(
        graph,
        keep_io_types=True,
        disable_shape_infer=False,
        op_block_list=["Resize"],
    )
    fp16=out/"usr2-baseplus-ctc-fp16.onnx"
    onnx.save(graph16,fp16)
    onnx.checker.check_model(fp16)

    # Basic numerical smoke test before chunking.
    import numpy as np
    import onnxruntime as ort
    sess=ort.InferenceSession(str(fp16),providers=["CPUExecutionProvider"])
    test=np.zeros((1,24,88,88),dtype=np.float16)
    result=sess.run(None,{"video":test})[0]
    if result.ndim!=3 or result.shape[0]!=1 or result.shape[-1]!=1049:
        raise RuntimeError(f"Unexpected browser graph output shape {result.shape}")
    print("FP16 smoke output:",result.shape,result.dtype, flush=True)

    # Tokens: same ordered list used by USR. Blank is 0, EOS is last.
    labels=(source/"utils/labels/unigram1000_units.txt").read_text().splitlines()
    tokens=["<blank>"]+[line.split()[0] for line in labels]+["<eos>"]
    (out/"tokens.json").write_text(json.dumps(tokens,ensure_ascii=False,separators=(",",":")))

    # Mean-face points for browser reproduction of USR's MediaPipe preprocessing.
    import numpy as np
    mean=np.load(source/"preprocessing/20words_mean_face.npy")
    (out/"mean-face.json").write_text(json.dumps(mean.tolist(),separators=(",",":")))

    # A single ONNX protobuf is easiest for ORT Web. Split it only for Git/GitHub.
    parts=[]
    total=fp16.stat().st_size
    with fp16.open("rb") as src:
        index=0
        while True:
            data=src.read(PART_BYTES)
            if not data: break
            name=f"usr2-baseplus-ctc-fp16.onnx.part{index:03d}"
            path=out/name
            path.write_bytes(data)
            parts.append({"file":name,"bytes":len(data),"sha256":sha256(path)})
            index+=1
    manifest={
        "format":1,
        "model":"USR 2.0 Base+ visual encoder + CTC head",
        "upstream":"https://github.com/ahaliassos/usr2",
        "revision":REVISION,
        "checkpoint_sha256":sha256(checkpoint),
        "onnx_sha256":sha256(fp16),
        "onnx_bytes":total,
        "input":{"name":"video","dtype":"float16","shape":["batch","frames",88,88],"normalization":{"mean":0.421,"std":0.165}},
        "output":{"name":"logits","tokens":1049},
        "parts":parts,
    }
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps({k:manifest[k] for k in ("model","onnx_bytes","onnx_sha256")},indent=2), flush=True)
    print("Parts:",len(parts), flush=True)

    # Keep artifact/repository payload lean.
    checkpoint.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)
    fp16.unlink(missing_ok=True)

if __name__=="__main__":
    main()
