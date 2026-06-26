FROM node:20-slim

# better-sqlite3 may need build tooling if no prebuilt binary is available
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Require the committed lockfile (no optional '*') and install from it exactly.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "src/index.js"]
