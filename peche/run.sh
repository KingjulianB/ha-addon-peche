#!/usr/bin/with-contenv bashio
# Démarrage de l'add-on Pêche Port-Gentil

export ADMIN_PASSWORD="$(bashio::config 'admin_password')"
export PECHEUR_PASSWORD="$(bashio::config 'pecheur_password')"
export NEMO_API_URL="$(bashio::config 'nemo_api_url')"
export NEMO_API_KEY="$(bashio::config 'nemo_api_key')"
export NEMO_DEVICE_ID="$(bashio::config 'nemo_device_id')"
export NEXTCLOUD_URL="$(bashio::config 'nextcloud_url')"
export NEXTCLOUD_USER="$(bashio::config 'nextcloud_user')"
export NEXTCLOUD_PASSWORD="$(bashio::config 'nextcloud_password')"
export NEXTCLOUD_FOLDER="$(bashio::config 'nextcloud_folder')"

export DB_PATH="/data/peche.db"
export PORT="3000"

bashio::log.info "Démarrage de l'application Pêche Port-Gentil…"
if bashio::config.is_empty 'nextcloud_url'; then
  bashio::log.info "Photos : stockage local (Nextcloud non configuré)."
else
  bashio::log.info "Photos : Nextcloud configuré (repli local si injoignable)."
fi
cd /app
exec node server/index.js
