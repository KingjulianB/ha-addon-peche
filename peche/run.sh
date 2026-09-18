#!/usr/bin/with-contenv bashio
# Démarrage de l'add-on Fisher Link

export ADMIN_EMAIL="$(bashio::config 'admin_email')"
export ADMIN_PASSWORD="$(bashio::config 'admin_password')"
export ENTREPRISE_NOM="$(bashio::config 'entreprise_nom')"
export SUPERADMIN_EMAILS="$(bashio::config 'superadmin_emails')"
export APP_BASE_URL="$(bashio::config 'app_base_url')"

export NEMO_API_URL="$(bashio::config 'nemo_api_url')"
export NEMO_API_KEY="$(bashio::config 'nemo_api_key')"
export NEMO_DEVICE_ID="$(bashio::config 'nemo_device_id')"

export NEXTCLOUD_URL="$(bashio::config 'nextcloud_url')"
export NEXTCLOUD_USER="$(bashio::config 'nextcloud_user')"
export NEXTCLOUD_PASSWORD="$(bashio::config 'nextcloud_password')"
export NEXTCLOUD_FOLDER="$(bashio::config 'nextcloud_folder')"

export SMTP_HOST="$(bashio::config 'smtp_host')"
export SMTP_PORT="$(bashio::config 'smtp_port')"
export SMTP_USER="$(bashio::config 'smtp_user')"
export SMTP_PASSWORD="$(bashio::config 'smtp_password')"
export SMTP_FROM="$(bashio::config 'smtp_from')"

export DB_PATH="/data/peche.db"
export PORT="3000"

bashio::log.info "Démarrage de Fisher Link…"
if bashio::config.is_empty 'smtp_host'; then
  bashio::log.info "Emails : SMTP non configuré — liens de vérification fournis manuellement."
else
  bashio::log.info "Emails : SMTP configuré."
fi
cd /app
exec node server/index.js
