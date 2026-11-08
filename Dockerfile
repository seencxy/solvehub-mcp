FROM node:20-alpine

WORKDIR /app
COPY package.json index.mjs ./

USER node

# stdio transport: keep stdin open, log to stderr only
ENTRYPOINT ["node", "index.mjs"]
