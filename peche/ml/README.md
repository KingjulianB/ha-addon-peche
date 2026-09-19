# Identification automatique (espèce + poids) — entraînement du modèle

Ce dossier contient le nécessaire pour entraîner le modèle utilisé par
`server/fishid.js`. L'entraînement se fait **hors du serveur** (pas
dans le conteneur Docker de l'add-on) : on obtient un fichier
`model.onnx`, on le copie ici, et le serveur s'en sert au démarrage.

Modèle actuel : classifieur **21 espèces** — les **12 espèces
gabonaises** (pêche artisanale côtière, Port-Gentil) — Ethmalose,
Otolithe sénégalais/Courbine, Mâchoiron, Capitaine, Carpe rouge/Pagre,
Bar barracuda, Thiof/Mérou, Carangue, Sole, Thon, Crevette, Sardinelle —
**fusionnées** avec les **9 espèces génériques** du dataset Kaggle "A
Large Scale Fish Dataset" (Sprat, Dorade royale, Chinchard, Rouget de
vase, Dorade rose, Bar européen, Crevette kaggle, Rouget de roche,
Truite). Ce dataset générique avait été utilisé pour le tout premier
modèle (2026-09-18), puis remplacé par le modèle Gabon-only
(2026-09-19, voir `planning/discrepancies.md` § Species Scope — revised
to Gabon-specific) — il a été **réintégré** le 2026-09-19 (même
journée) après une confusion observée en usage réel entre une classe
gabonaise ("Capitaine") et une espèce hors périmètre absente du modèle
Gabon-only ("bar") : plutôt que d'exclure les espèces génériques, elles
redeviennent des classes à part entière. Voir `planning/discrepancies.md`
§ Merge Kaggle + Gabon datasets.

**Déséquilibre de classes :** les 12 classes gabonaises n'ont que 19 à
132 photos chacune (GBIF/Wikimedia, disponibilité réelle limitée — voir
plus bas) contre 300 pour chacune des 9 classes génériques
(sous-échantillonnées depuis 1000, voir `download_kaggle.py`). `train.py`
pondère la perte par l'inverse de la fréquence de classe pour compenser,
mais les classes les plus rares restent structurellement moins bien
apprises — à surveiller si la confusion persiste après ce
réentraînement.

## Jeu de données : GBIF/iNaturalist

Aucun dataset "Golfe de Guinée"/Afrique de l'Ouest tout prêt n'existe
(vérifié sur Kaggle, Roboflow). `download_gbif.py` télécharge des
photos par espèce depuis l'API GBIF (qui agrège surtout des
observations iNaturalist, plus quelques collections de musées) :

```bash
pip install -r requirements.txt

python download_gbif.py --out data --max-per-species 150
```

Produit `data/<espèce>/*.jpg` (format attendu par
`torchvision.datasets.ImageFolder`) + un `attribution.json` par espèce
(auteur/licence/source de chaque photo).

**Important — à exécuter en local, pas dans Colab/Kaggle/etc. :**
plusieurs hébergeurs de photos (Natural History Museum Londres,
MNHN Paris) bloquent les téléchargements automatisés depuis les
adresses IP des plateformes cloud gratuites (Cloudflare, vérifié en
pratique) — depuis une machine personnelle normale, ça fonctionne.

**Licence :** majoritairement CC BY-NC (usage non-commercial) —
acceptée pour l'instant (voir `planning/project_log.md` #14), **à
revoir avant toute commercialisation de FisherLink**. Conservez les
`attribution.json` (auteur/licence/source par photo), c'est la preuve
d'attribution requise par CC BY-NC.

**Fiabilité des comptages par espèce :** GBIF peut rapporter plus
d'images "disponibles" que ce qui se télécharge réellement (échecs
403/timeout individuels, normal) — le script affiche à la fin le
nombre réellement téléchargé par espèce, c'est le seul chiffre fiable.
Avant d'entraîner, il vaut aussi la peine de vérifier qu'aucun fichier
n'est corrompu (`PIL.Image.verify()` sur chaque fichier de `data/`) —
un fichier illisible fait planter `train.py` en cours d'époque.

Certaines classes sont plus fines que d'autres (Otolithe sénégalais,
Mâchoiron, Carangue notamment) — normal vu la disponibilité réelle des
photos pour ces espèces en Afrique sur GBIF, voir
`planning/discrepancies.md`.

**Source complémentaire : Wikimedia Commons.** `download_wikimedia.py`
ajoute des photos supplémentaires (mêmes dossiers `data/<espèce>/`)
depuis les catégories Commons correspondantes — licences généralement
meilleures (CC0, domaine public, CC BY, en plus de CC BY-SA), toutes
exigent l'attribution (voir `attribution_wikimedia.json` par espèce,
séparé de celui de GBIF). **Important :** ce script demande des
miniatures (400px, `iiurlwidth`) plutôt que les images originales —
demander les originaux en rafale déclenche un blocage 429 de
Wikimedia, qui indique explicitement d'utiliser des miniatures pour un
accès automatisé en volume. 400px est largement suffisant pour
l'entraînement (`INPUT_SIZE = 224`).

```bash
python download_gbif.py --out data --max-per-species 150
python download_wikimedia.py --out data
```

**Source complémentaire ciblée : dataset Kaggle iNaturalist.**
`download_inaturalist_kaggle.py` ajoute des photos supplémentaires pour
4 classes seulement (Carangue, Bar barracuda, Thiof/Mérou, Carpe rouge/
Pagre) depuis un dataset Kaggle qui republie des observations
iNaturalist (`chandavandann/global-fish-species-image-dataset-inaturalist`,
licences par photo, majoritairement CC BY-NC) :

```bash
python download_inaturalist_kaggle.py --out data
```

Ne couvre PAS Capitaine/Ethmalose/Otolithe sénégalais/Mâchoiron —
aucune espèce du dataset ne correspond à ces genres (vérifié avant
d'écrire le script, voir `planning/discrepancies.md`).

## Jeu de données : Kaggle (9 espèces génériques)

`download_kaggle.py` télécharge et ajoute à `data/` les 9 classes du
dataset Kaggle "A Large Scale Fish Dataset" (`crowww/a-large-scale-fish-dataset`,
CC BY 4.0) — voir § historique plus haut. Nécessite une authentification
Kaggle (`pip install kaggle`, puis `~/.kaggle/kaggle.json` ou
`~/.kaggle/access_token`, voir https://www.kaggle.com/docs/api). Le zip
source (~3.5 Go) contient, par espèce, un dossier de vraies photos et un
dossier "<espèce> GT" de masques de segmentation (ignoré) ; il contient
aussi un dossier racine parasite `NA_Fish_Dataset` (ignoré, voir
`planning/project_log.md` #3). Chaque classe (1000 photos dans le zip)
est plafonnée à 300 par défaut pour limiter le déséquilibre avec les
classes gabonaises (voir § historique plus haut) :

```bash
python download_kaggle.py --out data --max-per-species 300
```

Avant d'entraîner, vérifiez aussi qu'aucune image n'est corrompue :

```bash
python -c "
import os
from PIL import Image
for root, _, files in os.walk('data'):
    for fn in files:
        if fn.lower().endswith(('.jpg', '.jpeg', '.png')):
            path = os.path.join(root, fn)
            try:
                with Image.open(path) as im:
                    im.verify()
            except Exception as e:
                print('invalide, supprimé:', path, e)
                os.remove(path)
"
```

## Entraînement

```bash
# Entraînement (transfer learning sur un MobileNetV2 pré-entraîné)
python train.py --data-dir data --epochs 10 --out model.pt --labels labels.json

# Export au format ONNX, consommé par server/fishid.js
python export_onnx.py --model model.pt --labels labels.json --out model.onnx
```

Sans GPU disponible (ex: quota Colab épuisé), l'entraînement tourne
aussi sur CPU — le modèle est petit (seule la tête de classification
est entraînée) et le jeu de données modeste, ça reste de l'ordre de la
demi-heure. `ml/train_colab.ipynb` reste disponible si un GPU gratuit
est accessible (Colab, Kaggle Notebooks, AWS SageMaker Studio Lab...) :
il clone ce dépôt, mais **charge les données via un zip uploadé**
(préparé en local avec `download_gbif.py`) plutôt que de les
télécharger depuis la plateforme cloud elle-même, pour la raison
expliquée ci-dessus.

Une fois `model.onnx` et `labels.json` présents dans ce dossier,
`fishIdConfigured()` (dans `server/fishid.js`) devient vrai
automatiquement au prochain démarrage du serveur — aucune autre
configuration n'est nécessaire.

## Poids estimé (`species_weights.json`)

Le modèle identifie l'**espèce** à partir de la photo. Comme convenu
(voir `planning/discrepancies.md` § Weight Estimation Method), le
**poids** n'est pas mesuré sur l'image (aucune échelle de référence
dans une photo) : c'est un poids **typique** par espèce, à confirmer ou
corriger par le pêcheur.

Format : `{ "<classe exacte du modèle, ex: labels.json>": { "nom_fr":
"<nom affiché au pêcheur>", "poids_kg": <poids typique>, "a": ...,
"b": ... } }`. La clé doit correspondre **exactement** à ce que le
modèle renvoie (= le nom du sous-dossier dans `data/`, voir
`SPECIES_QUERIES` dans `download_gbif.py`) — sinon `especeFr` retombe
sur le nom brut et `poidsEstimeKg` reste `null`, comme c'était le cas
avant que ce fichier ne soit corrigé une première fois (voir
`planning/project_log.md` #9).

Les valeurs `poids_kg`/`a`/`b` actuelles sont des valeurs de départ
tirées de la littérature générale par famille, **non vérifiées espèce
par espèce sur FishBase** — voir `planning/discrepancies.md` §
Allometry coefficients. Deux classes (**Capitaine**, **Thon**)
regroupent chacune plusieurs espèces de tailles adultes très
différentes, leur `poids_kg` est un compromis encore plus grossier.

## Réentraînement avec vos propres photos

Les photos de débarquement sont déjà stockées par l'application
(Nextcloud si configuré, sinon `/data/photos`). Une fois que vous en
avez accumulé un nombre suffisant avec l'espèce confirmée par un
pêcheur, elles peuvent être ajoutées à `data/<espèce>/` pour
réentraîner (`train.py --resume model.pt`) et affiner le modèle sur vos
propres conditions (bateau, éclairage, espèces locales réellement
pêchées) — c'est la meilleure façon de compenser le peu de photos GBIF
disponibles pour certaines espèces, et de sortir du biais "photo de
spécimen de musée" d'une partie du jeu de données actuel.
