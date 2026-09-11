FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

CMD ["node", "src/index.js"]
