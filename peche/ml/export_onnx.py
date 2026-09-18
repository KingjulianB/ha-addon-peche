"""Exporte le modèle entraîné (train.py) au format ONNX, consommé par
server/fishid.js.

Usage :
    python export_onnx.py --model model.pt --labels labels.json --out model.onnx
"""

import argparse
import json

import torch

from train import INPUT_SIZE, build_model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", default="model.onnx")
    args = ap.parse_args()

    with open(args.labels, encoding="utf-8") as f:
        labels = json.load(f)

    model = build_model(len(labels))
    model.load_state_dict(torch.load(args.model, map_location="cpu"))
    model.eval()

    dummy = torch.zeros(1, 3, INPUT_SIZE, INPUT_SIZE)
    torch.onnx.export(
        model,
        dummy,
        args.out,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )
    print(f"Exporté : {args.out}")


if __name__ == "__main__":
    main()
