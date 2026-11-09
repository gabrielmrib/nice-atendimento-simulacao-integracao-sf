FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public

USER node
EXPOSE 433
CMD ["node", "server.js"]