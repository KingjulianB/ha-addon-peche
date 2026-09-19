"""Ajoute à data/ des photos supplémentaires pour certaines classes
gabonaises depuis le dataset Kaggle "Global Fish Species Image Dataset
(iNaturalist)" (`chandavandann/global-fish-species-image-dataset-inaturalist`).

Contexte : voir planning/discrepancies.md § Merge Kaggle + Gabon
datasets — après la fusion avec les 9 espèces génériques Kaggle
(download_kaggle.py), quatre classes gabonaises étaient encore assez
fines (Carangue, Bar barracuda, Thiof/Mérou, Carpe rouge/Pagre). Ce
dataset (déjà republié sur Kaggle depuis des observations iNaturalist,
même source que download_gbif.py) contient quelques espèces
atlantiques proches ou identiques à nos espèces cibles — bien mieux
assorties géographiquement que le dataset Kaggle générique
("A Large Scale Fish Dataset", espèces méditerranéennes/turques
d'élevage) ou que "Fish Species Image Data" (Fish4Knowledge, poissons
de récif Indo-Pacifique, écarté — voir discrepancies.md).

Ne couvre PAS les 4 classes gabonaises les plus fines (Capitaine,
Ethmalose, Otolithe sénégalais, Mâchoiron) : aucune espèce du dataset
ne correspond à ces genres, vérifié avant d'écrire ce script.

Usage :

    pip install kaggle
    python download_inaturalist_kaggle.py --out data

Chaque photo garde sa licence d'origine (majoritairement CC BY-NC,
comme le reste du pipeline GBIF/iNaturalist) : les lignes de licence
vide dans le CSV source sont ignorées par prudence. Attribution par
photo écrite dans data/<classe>/attribution_inaturalist_kaggle.json.
"""

import argparse
import csv
import io
import json
import os
import zipfile

KAGGLE_DATASET = "chandavandann/global-fish-species-image-dataset-inaturalist"

# Nom scientifique (dans le CSV du dataset) -> classe gabonaise existante
# (doit rester synchronisé avec species_weights.json).
SPECIES_TO_CLASS = {
    "Caranx ruber": "Carangue",
    "Caranx melampygus": "Carangue",
    "Sphyraena barracuda": "Bar barracuda",
    "Epinephelus marginatus": "Thiof Merou",
    "Lutjanus apodus": "Carpe rouge Pagre",
    "Lutjanus griseus": "Carpe rouge Pagre",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    args = ap.parse_args()

    from kaggle.api.kaggle_api_extended import KaggleApi

    api = KaggleApi()
    api.authenticate()

    tmp_dir = os.path.join(args.out, "..", "kaggle_raw")
    os.makedirs(tmp_dir, exist_ok=True)
    print(f"Téléchargement de {KAGGLE_DATASET} (~2.7 Go)...")
    api.dataset_download_files(KAGGLE_DATASET, path=tmp_dir, unzip=False)
    zip_path = os.path.join(tmp_dir, "global-fish-species-image-dataset-inaturalist.zip")

    z = zipfile.ZipFile(zip_path)
    with z.open("fish_dataset/fish_dataset_metadata/all_downloaded_images-checkpoint.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        rows = list(reader)

    by_class = {}
    for r in rows:
        cls = SPECIES_TO_CLASS.get(r["scientific_name"])
        if not cls or not r["license_code"]:
            continue
        by_class.setdefault(cls, []).append(r)

    for cls, entries in by_class.items():
        dest_dir = os.path.join(args.out, cls)
        os.makedirs(dest_dir, exist_ok=True)
        attribution = []
        for r in entries:
            img_path = r["img_path"].replace("inat_fish_dataset/", "fish_dataset/fish_dataset/")
            try:
                data = z.read(img_path)
            except KeyError:
                continue
            fn = f"inat_{r['photo_id']}.jpg"
            with open(os.path.join(dest_dir, fn), "wb") as out:
                out.write(data)
            attribution.append({
                "file": fn,
                "scientific_name": r["scientific_name"],
                "license": r["license_code"],
                "source_url": r["source_url"],
            })
        attr_path = os.path.join(dest_dir, "attribution_inaturalist_kaggle.json")
        existing = []
        if os.path.exists(attr_path):
            with open(attr_path, encoding="utf-8") as f2:
                existing = json.load(f2)
        with open(attr_path, "w", encoding="utf-8") as f2:
            json.dump(existing + attribution, f2, ensure_ascii=False, indent=2)
        print(f"{cls}: +{len(attribution)} photo(s)")

    print(f"\nZip source conservé dans {tmp_dir}/ (supprimez-le manuellement si l'espace disque est limité).")


if __name__ == "__main__":
    main()
