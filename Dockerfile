FROM node:20-alpine

LABEL io.modelcontextprotocol.server.name="io.github.seencxy/solvehub-mcp"

WORKDIR /app

# zero runtime dependencies: the server only uses Node built-ins
COPY package.json index.mjs ./
COPY src ./src

USER node

# stdio transport: log to stderr, never stdout
ENTRYPOINT ["node", "index.mjs"]
