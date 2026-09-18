ARG BUILD_FROM
FROM $BUILD_FROM

# Installe Node.js et les outils pour compiler better-sqlite3
RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app

# Dépendances
COPY package.json ./
RUN npm install --omit=dev

# Code de l'application
COPY server ./server
COPY public ./public
COPY ml ./ml

# Script de démarrage s6 : l'image de base HA l'exécute automatiquement.
# Il doit être dans /etc/services.d/<nom>/run — PAS de CMD (géré par s6-overlay).
COPY run.sh /etc/services.d/peche/run
RUN chmod a+x /etc/services.d/peche/run
