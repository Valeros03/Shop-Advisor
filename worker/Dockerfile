FROM node:22-alpine

# Indispensabile per far girare Prisma su Alpine Linux
RUN apk add --no-cache openssl libc6-compat

WORKDIR /worker

COPY worker/package*.json ./
RUN npm install

# Copia lo schema ed esegue la generazione del client Prisma
COPY shop-advisor/prisma ./prisma
RUN npx prisma generate --schema=./prisma/schema.prisma

COPY worker/tsconfig.json ./
COPY worker/src ./src

CMD ["npm", "run", "worker"]