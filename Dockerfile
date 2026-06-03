FROM node:20-slim

# better-sqlite3 may need build tooling if no prebuilt binary is available
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "src/index.js"]
