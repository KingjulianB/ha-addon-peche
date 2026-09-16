# Installer l'application Pêche sur votre Home Assistant

Ce dépôt est un **add-on Home Assistant**. Il fait tourner l'application de pêche
(journal de bord + suivi VMS) directement sur votre machine Home Assistant, à côté
de votre domotique — sans serveur payant.

## Étape 1 — Mettre ce dossier sur GitHub

Créez un dépôt GitHub (par exemple `ha-addon-peche`) et poussez-y le contenu du
dossier `ha-addon` (celui qui contient `repository.yaml` et le sous-dossier `peche`).

```
ha-addon-peche/
├── repository.yaml
└── peche/
    ├── config.yaml
    ├── Dockerfile
    ├── run.sh
    ├── DOCS.md
    ├── package.json
    ├── server/
    └── public/
```

## Étape 2 — Ajouter le dépôt dans Home Assistant

1. Dans Home Assistant : **Paramètres → Modules complémentaires → Boutique**.
2. En haut à droite (menu ⋮) → **Dépôts**.
3. Collez l'URL de votre dépôt GitHub, puis **Ajouter**.
4. L'add-on « Pêche Port-Gentil » apparaît dans la liste. Cliquez dessus → **Installer**.

## Étape 3 — Configurer et démarrer

1. Onglet **Configuration** : changez `app_password` (votre mot de passe d'accès).
   Laissez les champs NEMO vides pour l'instant.
2. Onglet **Info** : démarrez l'add-on. Activez « Démarrer au boot » et
   « Watchdog » pour qu'il redémarre tout seul.
3. Testez en local : `http://IP-DE-VOTRE-HA:3000`

## Étape 4 — Exposer via votre tunnel Cloudflare

Vous accédez déjà à Home Assistant par Cloudflare Tunnel. Ajoutez simplement une
nouvelle règle pour l'application, sur son propre sous-domaine :

1. Dans le tableau de bord **Cloudflare Zero Trust → Networks → Tunnels**,
   ouvrez votre tunnel existant → **Public Hostnames** → **Add a public hostname**.
2. Renseignez :
   - **Subdomain** : `peche` (donnera `peche.tondomaine.com`)
   - **Domain** : votre domaine
   - **Service** : `HTTP` → `localhost:3000`
3. Enregistrez. Cloudflare gère le HTTPS automatiquement.

Votre partenaire au Gabon accède alors à `https://peche.tondomaine.com`, avec le
mot de passe. Votre interface Home Assistant reste sur son propre sous-domaine,
séparée.

## Sauvegarde

La base (`/data/peche.db`) est incluse dans les sauvegardes Home Assistant.
Pour une copie manuelle, utilisez l'add-on « Samba » ou « SSH » de HA pour
récupérer le fichier.

## Brancher NEMO plus tard

Quand CLS vous fournira l'accès API : remplissez `nemo_api_url`, `nemo_api_key`,
`nemo_device_id` dans la configuration de l'add-on, complétez `server/nemo.js`
selon leur documentation, poussez la nouvelle version sur GitHub et rechargez
l'add-on. Le bouton « Synchroniser NEMO » apparaîtra dans l'application.
