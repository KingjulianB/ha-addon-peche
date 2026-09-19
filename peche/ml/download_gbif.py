"""Télécharge des photos d'entraînement pour le classifieur Gabon depuis GBIF.

Contexte : voir planning/discrepancies.md § "Species Scope — revised to
Gabon-specific" — aucun dataset "Golfe de Guinée" tout prêt n'existe ;
GBIF (qui agrège surtout des observations iNaturalist) est la source
retenue. Licence : majoritairement CC BY-NC — utilisation acceptée pour
l'instant (usage interne/gratuit), voir planning/project_log.md #14.
**CC BY-NC exige l'attribution** : ce script écrit un fichier
`attribution.json` par espèce avec auteur/licence/source de chaque
photo téléchargée — à conserver, ne pas supprimer.

Usage :

    python download_gbif.py --out data --max-per-species 150

Produit `data/<espèce>/*.jpg` + `data/<espèce>/attribution.json`, au
format attendu par train.py (torchvision ImageFolder : un sous-dossier
par classe). Les noms de sous-dossiers (français) deviennent les
classes du modèle — ce sont ces mêmes noms qui doivent être utilisés
comme clés dans ml/species_weights.json.

Ne dépend que de la bibliothèque standard (urllib) — aucune
installation supplémentaire nécessaire au-delà de ce que train.py
requiert déjà.
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

GBIF_SEARCH = "https://api.gbif.org/v1/occurrence/search"
PAGE_SIZE = 100
REQUEST_DELAY_S = 0.3  # courtoisie envers l'API GBIF (pas de clé/quota connu)

# Espèce affichée (= nom de classe du modèle, = clé attendue dans
# species_weights.json) -> liste de noms scientifiques interrogés sur
# GBIF. Certains genres (Pagrus, Caranx) renvoient 0 résultat en
# recherche par genre nu sur GBIF (voir discrepancies.md) — on
# interroge donc les espèces précises trouvées à la place.
SPECIES_QUERIES = {
    "Ethmalose": ["Ethmalosa fimbriata"],
    "Otolithe senegalais": ["Pseudotolithus senegalensis"],
    "Machoiron": ["Arius"],
    "Capitaine": ["Galeoides decadactylus", "Polydactylus quadrifilis"],
    "Carpe rouge Pagre": ["Dentex", "Pagrus caeruleostictus", "Pagrus pagrus", "Lutjanus agennes"],
    "Bar barracuda": ["Sphyraena"],
    "Thiof Merou": ["Epinephelus"],
    "Carangue": ["Caranx hippos", "Caranx senegallus"],
    "Sole": ["Cynoglossus"],
    "Thon": ["Thunnus", "Katsuwonus pelamis"],
    "Crevette": ["Penaeus"],
    "Sardinelle": ["Sardinella"],
}


def gbif_search(scientific_name, offset):
    params = {
        "scientificName": scientific_name,
        "mediaType": "StillImage",
        "continent": "AFRICA",
        "limit": PAGE_SIZE,
        "offset": offset,
    }
    url = f"{GBIF_SEARCH}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "FisherLink-fishid-dataset/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def iter_media_records(scientific_name, max_count):
    """Yield (media_dict, occurrence_record) pour une espèce, jusqu'à max_count images."""
    offset = 0
    yielded = 0
    while yielded < max_count:
        data = gbif_search(scientific_name, offset)
        results = data.get("results", [])
        if not results:
            break
        for occ in results:
            for media in occ.get("media", []):
                if media.get("type") != "StillImage" or not media.get("identifier"):
                    continue
                yield media, occ
                yielded += 1
                if yielded >= max_count:
                    return
        if data.get("endOfRecords"):
            break
        offset += PAGE_SIZE
        time.sleep(REQUEST_DELAY_S)


def download_one(url, dest_path):
    req = urllib.request.Request(url, headers={"User-Agent": "FisherLink-fishid-dataset/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    with open(dest_path, "wb") as f:
        f.write(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data", help="dossier de sortie (défaut: data/, attendu par train.py)")
    ap.add_argument("--max-per-species", type=int, default=150)
    ap.add_argument("--dry-run", action="store_true", help="compte les images disponibles sans rien télécharger")
    args = ap.parse_args()

    total_downloaded = 0
    for species_label, scientific_names in SPECIES_QUERIES.items():
        species_dir = os.path.join(args.out, species_label)
        attribution = []
        seen_urls = set()
        per_species_count = 0
        # répartit le quota entre les noms scientifiques de ce groupe
        budget = max(1, args.max_per_species // len(scientific_names))

        for name in scientific_names:
            if per_species_count >= args.max_per_species:
                break
            remaining = min(budget, args.max_per_species - per_species_count)
            try:
                records = list(iter_media_records(name, remaining))
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"  ! échec requête GBIF pour {name!r} : {e}")
                continue

            for media, occ in records:
                img_url = media["identifier"]
                if img_url in seen_urls:
                    continue
                seen_urls.add(img_url)

                if args.dry_run:
                    per_species_count += 1
                    continue

                os.makedirs(species_dir, exist_ok=True)
                gbif_id = occ.get("gbifID", len(attribution))
                ext = ".jpg" if ".png" not in img_url.lower() else ".png"
                dest = os.path.join(species_dir, f"{gbif_id}{ext}")
                try:
                    download_one(img_url, dest)
                except (urllib.error.URLError, TimeoutError) as e:
                    print(f"    ! échec téléchargement {img_url} : {e}")
                    continue

                attribution.append({
                    "file": os.path.basename(dest),
                    "scientific_name": name,
                    "source_url": img_url,
                    "license": media.get("license", "inconnue"),
                    "rights_holder": media.get("rightsHolder") or media.get("creator") or "inconnu",
                    "gbif_occurrence": occ.get("references") or occ.get("occurrenceID"),
                })
                per_species_count += 1
                total_downloaded += 1
                time.sleep(REQUEST_DELAY_S)

        if not args.dry_run and attribution:
            os.makedirs(species_dir, exist_ok=True)
            with open(os.path.join(species_dir, "attribution.json"), "w", encoding="utf-8") as f:
                json.dump(attribution, f, ensure_ascii=False, indent=2)

        print(f"{species_label}: {per_species_count} image(s)" + (" (dry-run, non téléchargées)" if args.dry_run else ""))

    if not args.dry_run:
        print(f"\nTotal téléchargé : {total_downloaded} images dans {args.out}/")
        print("Rappel licence : majoritairement CC BY-NC (voir attribution.json par espèce) — "
              "usage interne/gratuit pour l'instant, à revoir avant toute commercialisation "
              "(planning/project_log.md #14).")


if __name__ == "__main__":
    main()
