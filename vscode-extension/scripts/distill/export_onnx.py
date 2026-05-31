"""Export the distilled HF model to INT8-quantized ONNX consumed by Transformers.js.

Usage:
  python export_onnx.py \\
      --model ../../.distill-work/final \\
      --out   ../../models/distilled-rewriter
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def _run(cmd: list[str]) -> None:
    print(">", " ".join(cmd))
    subprocess.check_call(cmd)


def _human_size(num_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num_bytes < 1024:
            return f"{num_bytes:.1f} {unit}"
        num_bytes /= 1024  # type: ignore[assignment]
    return f"{num_bytes:.1f} TB"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    raw = args.out / "_raw"
    final = args.out
    raw.mkdir(parents=True, exist_ok=True)
    final.mkdir(parents=True, exist_ok=True)

    _run([
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", str(args.model),
        "--task", "text2text-generation-with-past",
        str(raw),
    ])

    from onnxruntime.quantization import QuantType, quantize_dynamic

    onnx_dir = final / "onnx"
    onnx_dir.mkdir(exist_ok=True)

    candidates = [
        "encoder_model.onnx",
        "decoder_model_merged.onnx",
        "decoder_model.onnx",
        "decoder_with_past_model.onnx",
    ]
    exported = list(raw.glob("*.onnx"))
    if not exported:
        raise SystemExit(f"No .onnx files produced under {raw}.")

    for name in candidates:
        src = raw / name
        if not src.exists():
            continue
        dst = onnx_dir / name.replace(".onnx", "_quantized.onnx")
        quantize_dynamic(str(src), str(dst), weight_type=QuantType.QInt8)
        print(f"Quantized {name} -> {dst.name}")

    for name in (
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "generation_config.json",
        "spiece.model",
    ):
        src = args.model / name
        if src.exists():
            shutil.copy(src, final / name)

    shutil.rmtree(raw, ignore_errors=True)

    total = sum(p.stat().st_size for p in final.rglob("*") if p.is_file())
    print(f"Quantized ONNX bundle ready at {final} ({_human_size(total)})")


if __name__ == "__main__":
    main()
