"""Entraînement du classifieur d'espèces (transfer learning sur MobileNetV2).

Voir README.md pour le contexte. Usage :

    python train.py --data-dir data --epochs 10 --out model.pt --labels labels.json

`data-dir` doit contenir un sous-dossier par espèce, chacun rempli de
photos de cette espèce (format attendu par torchvision.datasets.ImageFolder) :

    data/
      bar/photo1.jpg ...
      thon/photo1.jpg ...
      ...

Ceci entraîne uniquement le classifieur d'ESPÈCE. Le poids est géré
séparément par un lookup (species_weights.json), pas par ce script —
voir README.md § Poids estimé.
"""

import argparse
import json
from collections import Counter

import torch
from torch import nn
from torch.utils.data import DataLoader, random_split
from torchvision import datasets, models, transforms

INPUT_SIZE = 224  # doit correspondre à server/fishid.js


def build_model(num_classes):
    model = models.mobilenet_v2(weights=models.MobileNet_V2_Weights.DEFAULT)
    for param in model.features.parameters():
        param.requires_grad = False  # on ne réentraîne que la tête au départ
    model.classifier[1] = nn.Linear(model.last_channel, num_classes)
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", default="model.pt")
    ap.add_argument("--labels", default="labels.json")
    ap.add_argument("--resume", default=None, help="checkpoint .pt existant, pour continuer l'entraînement")
    args = ap.parse_args()

    tfm = transforms.Compose([
        transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
        transforms.RandomHorizontalFlip(),
        transforms.ToTensor(),
    ])
    dataset = datasets.ImageFolder(args.data_dir, transform=tfm)
    labels = dataset.classes
    n_val = max(1, int(0.15 * len(dataset)))
    train_ds, val_ds = random_split(dataset, [len(dataset) - n_val, n_val])
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_model(len(labels)).to(device)
    if args.resume:
        model.load_state_dict(torch.load(args.resume, map_location=device))

    opt = torch.optim.Adam(model.classifier.parameters(), lr=args.lr)

    # Classes très déséquilibrées (ex: dataset fusionné Gabon+Kaggle, de 19 à
    # 300 photos selon la classe) — pondère la perte par l'inverse de la
    # fréquence de classe pour éviter que le modèle ignore les classes rares.
    counts = Counter(label for _, label in dataset.samples)
    class_weights = torch.tensor(
        [len(dataset) / counts[i] for i in range(len(labels))], dtype=torch.float32
    ).to(device)
    loss_fn = nn.CrossEntropyLoss(weight=class_weights)

    for epoch in range(args.epochs):
        model.train()
        total_loss = 0.0
        for images, targets in train_loader:
            images, targets = images.to(device), targets.to(device)
            opt.zero_grad()
            out = model(images)
            loss = loss_fn(out, targets)
            loss.backward()
            opt.step()
            total_loss += loss.item() * images.size(0)

        model.eval()
        correct, total = 0, 0
        with torch.no_grad():
            for images, targets in val_loader:
                images, targets = images.to(device), targets.to(device)
                pred = model(images).argmax(dim=1)
                correct += (pred == targets).sum().item()
                total += targets.size(0)
        acc = correct / total if total else 0.0
        print(f"époque {epoch + 1}/{args.epochs} — perte {total_loss / len(train_ds):.4f} — précision val {acc:.2%}")

    torch.save(model.state_dict(), args.out)
    with open(args.labels, "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, indent=2)
    print(f"Modèle sauvegardé : {args.out} ({len(labels)} espèces) — labels : {args.labels}")


if __name__ == "__main__":
    main()
