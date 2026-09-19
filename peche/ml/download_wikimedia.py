"""Complète le jeu de données d'entraînement avec des photos Wikimedia Commons.

Source supplémentaire à ml/download_gbif.py (GBIF/iNaturalist) — voir
planning/discrepancies.md § Species Scope. Wikimedia Commons donne
généralement moins de volume par espèce que GBIF pour ces poissons
ouest-africains, mais des licences souvent plus permissives (CC0,
domaine public, CC BY, en plus de CC BY-SA) — toutes les licences
Commons exigent au moins l'attribution, jamais "tous droits réservés"
(Commons n'héberge que du contenu librement réutilisable).

Usage :

    python download_wikimedia.py --out data

Ajoute des photos dans data/<espèce>/ (mêmes dossiers que
download_gbif.py, à exécuter après ou avant, l'ordre n'importe pas) et
fusionne dans un attribution.json séparé par source
(attribution_wikimedia.json) pour ne pas écraser celui de GBIF.

Ne dépend que de la bibliothèque standard (urllib), comme
download_gbif.py.
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
REQUEST_DELAY_S = 1.5

# Mêmes classes que download_gbif.py (SPECIES_QUERIES) — catégories
# Wikimedia Commons interrogées par espèce/genre. Une catégorie absente
# ou vide sur Commons renvoie simplement 0 résultat, pas une erreur.
SPECIES_QUERIES = {
    "Ethmalose": ["Ethmalosa fimbriata"],
    "Otolithe senegalais": ["Pseudotolithus senegalensis"],
    "Machoiron": ["Arius"],
    "Capitaine": ["Galeoides decadactylus", "Polydactylus quadrifilis"],
    "Carpe rouge Pagre": ["Dentex", "Pagrus caeruleostictus", "Pagrus pagrus", "Lutjanus agennes"],
    "Bar barracuda": ["Sphyraena"],
    "Thiof Merou": ["Epinephelus", "Epinephelus aeneus"],
    "Carangue": ["Caranx hippos", "Caranx senegallus"],
    "Sole": ["Cynoglossus", "Cynoglossidae"],
    "Thon": ["Thunnus", "Katsuwonus pelamis"],
    "Crevette": ["Penaeus"],
    "Sardinelle": ["Sardinella"],
}

PHOTO_MIME_TYPES = {"image/jpeg", "image/png"}


def api_get(params):
    url = f"{API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "FisherLink-fishid-dataset/1.0 (contact: project maintainer)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def category_files(category_name):
    """Retourne la liste des fichiers-images (avec métadonnées) d'une catégorie Commons."""
    params = {
        "action": "query",
        "generator": "categorymembers",
        "gcmtitle": f"Category:{category_name}",
        "gcmtype": "file",
        "gcmlimit": 200,
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime",
        # Demande une miniature (400px) plutôt que l'original: bien assez pour
        # un entraînement en 224x224, et surtout ce que Wikimedia demande
        # explicitement d'utiliser pour un accès automatisé en volume (leur
        # API d'origine renvoie un 429 "please ... use thumbnail images" sinon
        # — voir planning/discrepancies.md).
        "iiurlwidth": 400,
        "format": "json",
    }
    data = None
    for attempt in range(4):
        try:
            data = api_get(params)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                wait = 5 * (attempt + 1)
                print(f"  … 429 sur {category_name!r}, nouvelle tentative dans {wait}s")
                time.sleep(wait)
                continue
            print(f"  ! échec requête Commons pour {category_name!r} : {e}")
            return []
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  ! échec requête Commons pour {category_name!r} : {e}")
            return []
    if data is None:
        return []
    pages = data.get("query", {}).get("pages", {})
    out = []
    for page in pages.values():
        infos = page.get("imageinfo")
        if not infos:
            continue
        info = infos[0]
        if info.get("mime") not in PHOTO_MIME_TYPES:
            continue  # exclut cartes/diagrammes SVG, GIF, gravures scannées en PDF, etc.
        out.append((page, info))
    return out


def download_one(url, dest_path):
    req = urllib.request.Request(url, headers={"User-Agent": "FisherLink-fishid-dataset/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            with open(dest_path, "wb") as f:
                f.write(data)
            return
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                wait = 5 * (attempt + 1)
                time.sleep(wait)
                continue
            raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total = 0
    for species_label, categories in SPECIES_QUERIES.items():
        species_dir = os.path.join(args.out, species_label)
        attribution = []
        seen_pageids = set()
        n = 0

        for cat in categories:
            time.sleep(REQUEST_DELAY_S)
            for page, info in category_files(cat):
                pageid = page["pageid"]
                if pageid in seen_pageids:
                    continue
                seen_pageids.add(pageid)

                if args.dry_run:
                    n += 1
                    continue

                img_url = info.get("thumburl") or info["url"]
                os.makedirs(species_dir, exist_ok=True)
                ext = os.path.splitext(img_url.split("?")[0])[1] or ".jpg"
                dest = os.path.join(species_dir, f"wm_{pageid}{ext}")
                try:
                    download_one(img_url, dest)
                except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                    print(f"    ! échec téléchargement {img_url} : {e}")
                    continue
                time.sleep(REQUEST_DELAY_S)

                meta = info.get("extmetadata", {})
                attribution.append({
                    "file": os.path.basename(dest),
                    "commons_category": cat,
                    "source_url": info.get("descriptionurl"),
                    "license": meta.get("LicenseShortName", {}).get("value", "inconnue"),
                    "rights_holder": meta.get("Artist", {}).get("value") or meta.get("Credit", {}).get("value") or "inconnu",
                })
                n += 1
                total += 1
                time.sleep(REQUEST_DELAY_S)

        if not args.dry_run and attribution:
            os.makedirs(species_dir, exist_ok=True)
            attr_path = os.path.join(species_dir, "attribution_wikimedia.json")
            existing = []
            if os.path.exists(attr_path):
                with open(attr_path, encoding="utf-8") as f:
                    existing = json.load(f)
            existing.extend(attribution)
            with open(attr_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)

        print(f"{species_label}: {n} image(s)" + (" (dry-run)" if args.dry_run else ""))

    if not args.dry_run:
        print(f"\nTotal téléchargé : {total} images dans {args.out}/ (ajoutées aux photos GBIF existantes)")
        print("Licences variées (CC0, domaine public, CC BY, CC BY-SA) — voir attribution_wikimedia.json par espèce, "
              "attribution requise dans tous les cas.")


if __name__ == "__main__":
    main()
