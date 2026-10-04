FROM node:22-alpine

# Indispensabile per far girare Prisma su Alpine Linux
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm install

# Genera subito i tipi di Prisma dentro il container
RUN npx prisma generate

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
