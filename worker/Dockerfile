FROM node:22-alpine

WORKDIR /worker

COPY worker/package.json ./
RUN npm install

# Il worker genera il client Prisma dallo stesso schema usato dall'applicazione.
COPY shop-advisor/prisma ./prisma
RUN npx prisma generate --schema=./prisma/schema.prisma

COPY worker/tsconfig.json ./
COPY worker/src ./src

CMD ["npm", "run", "index"]
