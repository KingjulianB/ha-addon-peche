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
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
