#!/usr/bin/with-contenv bashio
# ============================================================
#  Démarrage de l'add-on Pêche Port-Gentil
#  Lit les options configurées dans l'interface Home Assistant
#  et lance le serveur Node.
# ============================================================

# Récupère les options définies dans l'onglet Configuration de l'add-on
export APP_PASSWORD="$(bashio::config 'app_password')"
export NEMO_API_URL="$(bashio::config 'nemo_api_url')"
export NEMO_API_KEY="$(bashio::config 'nemo_api_key')"
export NEMO_DEVICE_ID="$(bashio::config 'nemo_device_id')"

# La base de données vit dans /data (persistant, sauvegardé par Home Assistant)
export DB_PATH="/data/peche.db"
export PORT="3000"

bashio::log.info "Démarrage de l'application Pêche Port-Gentil…"
if bashio::config.is_empty 'nemo_api_url'; then
  bashio::log.info "NEMO non configuré — import manuel des traces actif."
else
  bashio::log.info "NEMO configuré."
fi

cd /app
exec node server/index.js
