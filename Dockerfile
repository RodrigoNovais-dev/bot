FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system url.https://github.com/.insteadOf ssh://git@github.com/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/

CMD ["node", "src/index.js"]
