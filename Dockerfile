FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/arncode
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm link --omit=dev \
    && npm cache clean --force

RUN mkdir -p /work /home/node/.arncode \
    && chown node:node /work /home/node/.arncode \
    && chmod 700 /home/node/.arncode
USER node
ENV ARNCODE_CONFIG_DIR=/home/node/.arncode
WORKDIR /work
ENTRYPOINT ["arncode"]
