"""Télécharge le dataset générique Kaggle "A Large Scale Fish Dataset" et
l'ajoute à data/ (mêmes dossiers data/<espèce>/ que download_gbif.py et
download_wikimedia.py) pour produire le modèle fusionné Gabon + générique.

Contexte : voir planning/discrepancies.md § "Merge Kaggle + Gabon
datasets" — le modèle Gabon-only (12 espèces) confondait des espèces
absentes de son périmètre avec les classes existantes ; plutôt que
d'exclure ces espèces, elles sont réintégrées comme classes à part
entière (dataset original utilisé par le tout premier modèle, voir
planning/project_log.md #10, avant son remplacement le 2026-09-19).

Usage :

    pip install kaggle
    # authentification : https://www.kaggle.com/docs/api
    #   - soit ~/.kaggle/kaggle.json (username + key, ancien format)
    #   - soit ~/.kaggle/access_token (nouveau token API, un seul fichier)
    python download_kaggle.py --out data

Le zip source (crowww/a-large-scale-fish-dataset, CC BY 4.0, ~3.5 Go)
contient pour chaque espèce un dossier de vraies photos ET un dossier
"<espèce> GT" de masques de segmentation (noir/blanc, PAS des photos) —
ce script ne prend que les vraies photos. Il contient aussi un dossier
racine "NA_Fish_Dataset" parasite (sous-échantillon dupliqué, voir
planning/project_log.md #3) qui est ignoré.

Chaque classe du zip (1000 photos) est plafonnée à `--max-per-species`
(défaut 300) : les 12 classes gabonaises n'ont que 19 à 132 photos
(GBIF/Wikimedia, voir download_gbif.py/download_wikimedia.py) — garder
1000 photos/classe pour les 9 classes génériques écraserait
l'entraînement sous ce déséquilibre bien au-delà de ce que la
pondération de perte (voir train.py) peut compenser raisonnablement, et
multiplierait le temps d'entraînement CPU sans gain net (les retours
marginaux d'un transfer learning MobileNetV2 sont faibles au-delà de
quelques centaines d'exemples/classe).
"""

import argparse
import json
import os
import random

# Nom de classe du zip Kaggle -> nom de classe utilisé dans data/ (français,
# sans accents pour rester cohérent avec les classes gabonaises existantes).
# Ces noms doivent rester synchronisés avec les clés de species_weights.json.
MAPPING = {
    "Black Sea Sprat": "Sprat",
    "Gilt-Head Bream": "Dorade royale",
    "Hourse Mackerel": "Chinchard",
    "Red Mullet": "Rouget de vase",
    "Red Sea Bream": "Dorade rose",
    "Sea Bass": "Bar europeen",
    "Shrimp": "Crevette kaggle",
    "Striped Red Mullet": "Rouget de roche",
    "Trout": "Truite",
}

KAGGLE_DATASET = "crowww/a-large-scale-fish-dataset"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data", help="dossier de sortie (défaut: data/, attendu par train.py)")
    ap.add_argument("--max-per-species", type=int, default=300)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    import zipfile

    from kaggle.api.kaggle_api_extended import KaggleApi

    api = KaggleApi()
    api.authenticate()

    tmp_dir = os.path.join(args.out, "..", "kaggle_raw")
    os.makedirs(tmp_dir, exist_ok=True)
    print(f"Téléchargement de {KAGGLE_DATASET} (~3.5 Go)...")
    api.dataset_download_files(KAGGLE_DATASET, path=tmp_dir, unzip=False)
    zip_path = os.path.join(tmp_dir, "a-large-scale-fish-dataset.zip")

    rng = random.Random(args.seed)
    z = zipfile.ZipFile(zip_path)
    for kaggle_name, fr_name in MAPPING.items():
        dest_dir = os.path.join(args.out, fr_name)
        os.makedirs(dest_dir, exist_ok=True)
        members = [
            n for n in z.namelist()
            if n.lower().endswith(".png")
            and n.split("/")[:4] == ["Fish_Dataset", "Fish_Dataset", kaggle_name, kaggle_name]
        ]
        rng.shuffle(members)
        members = members[: args.max_per_species]
        for member in members:
            fn = os.path.basename(member)
            with z.open(member) as src, open(os.path.join(dest_dir, fn), "wb") as dst:
                dst.write(src.read())
        with open(os.path.join(dest_dir, "attribution.json"), "w", encoding="utf-8") as f:
            json.dump({
                "source": f"Kaggle - A Large Scale Fish Dataset ({KAGGLE_DATASET})",
                "kaggle_class": kaggle_name,
                "license": "CC BY 4.0",
                "url": f"https://www.kaggle.com/datasets/{KAGGLE_DATASET}",
                "note": "Photos studio/marché (fond uniforme), pas des captures réelles du Gabon — voir caveat domain-shift dans planning/discrepancies.md",
            }, f, ensure_ascii=False, indent=2)
        print(f"{kaggle_name} -> {args.out}/{fr_name}: {len(members)} photo(s)")

    print(f"\nZip source conservé dans {tmp_dir}/ (supprimez-le manuellement si l'espace disque est limité).")


if __name__ == "__main__":
    main()
