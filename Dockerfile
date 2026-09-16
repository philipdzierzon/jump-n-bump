# Build the client, then serve it and the WebSocket from one Node process (#11).
FROM node:22-alpine AS client
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY .babelrc webpack.config.js ./
COPY src ./src
COPY game ./game
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js server/smoke.mjs ./
COPY --from=client /build/game ./game
ENV CLIENT_DIR=/app/game PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
