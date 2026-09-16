# Pêche Port-Gentil — add-on Home Assistant

Journal de bord électronique et suivi VMS pour la pêche artisanale, compatible
avec la balise NEMO. Fonctionne comme add-on sur votre Home Assistant OS.

## Configuration

Dans l'onglet **Configuration** de l'add-on :

- **app_password** : le mot de passe d'accès (vous + votre partenaire). **Changez-le.**
- **nemo_api_url / nemo_api_key / nemo_device_id** : à remplir plus tard, quand
  vous aurez obtenu l'accès API auprès de CLS (clsfishingteam@groupcls.com).
  Laissez vide pour l'instant : l'import manuel des traces reste actif.

## Accès

L'application écoute sur le port **3000** de votre machine Home Assistant.

- **En local** : `http://IP-DE-VOTRE-HA:3000`
- **Depuis l'extérieur** (votre partenaire au Gabon) : ajoutez une règle dans
  votre tunnel Cloudflare pointant votre sous-domaine (ex. `peche.tondomaine.com`)
  vers `http://localhost:3000` (voir le README d'installation).

## Données et sauvegarde

La base de données est stockée dans `/data/peche.db`, inclus automatiquement dans
les **sauvegardes Home Assistant**. Pensez à sauvegarder régulièrement.

## Mise à jour

Modifiez la version dans `config.yaml`, poussez sur votre dépôt GitHub, puis
rechargez l'add-on depuis Home Assistant.
