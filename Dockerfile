# Build the client, then serve it and the WebSocket from one Node process (#11).
FROM node:22-alpine AS client
WORKDIR /build
COPY package.json package-lock.json ./
# Webpack is a dev dependency, so the build stage needs them all -- but `playwright` pulls a
# browser down on install and nothing in this image ever opens one: the browser suite runs on
# the host, or in CI, against the container this builds (#65).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY .babelrc webpack.config.js ./
COPY src ./src
COPY game ./game
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js server/smoke.mjs ./
# The repo's own layout, because the relay validates room ids and room config with the
# client's own modules rather than a second copy of the alphabet and the key list (#8, #38).
WORKDIR /app
COPY src/net/room_id.js src/net/room_config.js ./src/net/
COPY --from=client /build/game ./game
# The site statistics' one row (#46). compose bind-mounts ./data/relay over this directory;
# without a mount, a plain `docker run` (CI) still has somewhere to open the file.
RUN mkdir /app/data
ENV CLIENT_DIR=/app/game PORT=8080 STATS_DB=/app/data/stats.db
EXPOSE 8080
CMD ["node", "server/index.js"]
