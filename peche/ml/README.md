# Identification automatique (espèce + poids) — entraînement du modèle

Ce dossier contient le nécessaire pour entraîner le modèle utilisé par
`server/fishid.js`. L'entraînement se fait **hors du serveur** (pas
dans le conteneur Docker de l'add-on) : on obtient un fichier
`model.onnx`, on le copie ici, et le serveur s'en sert au démarrage.

## Ce qui manque encore pour entraîner réellement

- **Python 3.10+ avec pip**, installé séparément sur une machine de
  développement (ce n'est pas nécessaire sur le serveur HA — seul le
  fichier `.onnx` final y est déployé). Au moment de la rédaction, ce
  n'était pas disponible sur la machine utilisée pour scaffolder ce
  dossier — voir `planning/discrepancies.md`.
- **Un jeu de données de photos de poissons étiquetées par espèce.**
  Pistes possibles : "A Large-Scale Fish Dataset" (Kaggle), Fish4Knowledge,
  WildFish, ou tout autre jeu de données public d'images de poissons par
  espèce. Aucun jeu de données n'a été téléchargé ni choisi
  définitivement — c'est la première chose à trancher avant de lancer
  `train.py`.
- **Du temps de calcul** (CPU suffit pour un premier entraînement avec
  peu d'époques sur un petit sous-ensemble d'espèces ; un GPU accélère
  beaucoup si vous entraînez sur un jeu de données large/"espèces
  générales").

## Étapes

```bash
pip install -r requirements.txt

# 1. Placez votre jeu de données sous data/<espèce>/*.jpg
#    (un sous-dossier par espèce, comme torchvision.datasets.ImageFolder l'attend)

# 2. Entraînement (transfer learning sur un MobileNetV2 pré-entraîné)
python train.py --data-dir data --epochs 10 --out model.pt --labels labels.json

# 3. Export au format ONNX, consommé par server/fishid.js
python export_onnx.py --model model.pt --labels labels.json --out model.onnx
```

Une fois `model.onnx` et `labels.json` présents dans ce dossier,
`fishIdConfigured()` (dans `server/fishid.js`) devient vrai
automatiquement au prochain démarrage du serveur — aucune autre
configuration n'est nécessaire.

## Poids estimé (`species_weights.json`)

Le modèle identifie l'**espèce** à partir de la photo. Comme convenu
(voir `planning/discrepancies.md` § Weight Estimation Method), le
**poids** n'est pas mesuré sur l'image (aucune échelle de référence
dans une photo) : c'est un poids **typique** par espèce, à confirmer ou
corriger par le pêcheur. `species_weights.json` ne contient qu'une
liste de départ, à corriger/compléter avec vos propres espèces locales
et vos observations réelles — ce n'est pas une donnée scientifique
fiable telle quelle.

## Réentraînement avec vos propres photos

Les photos de débarquement sont déjà stockées par l'application
(Nextcloud si configuré, sinon `/data/photos`). Une fois que vous en
avez accumulé un nombre suffisant avec l'espèce confirmée par un
pêcheur, elles peuvent être ajoutées à `data/<espèce>/` pour
réentraîner (`train.py --resume model.pt`) et affiner le modèle sur vos
propres conditions (bateau, éclairage, espèces locales réellement
pêchées) — voir `planning/project_log.md` décision #2.
