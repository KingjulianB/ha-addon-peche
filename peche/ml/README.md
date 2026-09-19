# Identification automatique (espèce + poids) — entraînement du modèle

Ce dossier contient le nécessaire pour entraîner le modèle utilisé par
`server/fishid.js`. L'entraînement se fait **hors du serveur** (pas
dans le conteneur Docker de l'add-on) : on obtient un fichier
`model.onnx`, on le copie ici, et le serveur s'en sert au démarrage.

Modèle actuel : classifieur **12 espèces gabonaises** (pêche
artisanale côtière, Port-Gentil) — Ethmalose, Otolithe sénégalais/
Courbine, Mâchoiron, Capitaine, Carpe rouge/Pagre, Bar barracuda,
Thiof/Mérou, Carangue, Sole, Thon, Crevette, Sardinelle. Il remplace un
premier modèle générique (9 espèces du dataset Kaggle "A Large Scale
Fish Dataset" — bar, dorade, truite... peu pertinentes pour le Gabon).
Voir `planning/discrepancies.md` § Species Scope — revised to
Gabon-specific pour l'historique de cette décision.

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
