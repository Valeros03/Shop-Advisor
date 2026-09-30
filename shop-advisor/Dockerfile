FROM node:22-alpine

WORKDIR /app

# Copiamo prima i file delle dipendenze per sfruttare la cache di Docker
COPY package*.json ./
COPY prisma ./prisma/

# Installiamo le dipendenze
RUN npm install

# Copiamo il resto del codice
COPY . .

# Esponiamo la porta di Next.js
EXPOSE 3000

# Comando per avviare il server in modalità sviluppo
CMD ["npm", "run", "dev"]