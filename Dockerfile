FROM node:24-alpine AS builder

WORKDIR /build

# Copy securellm-mcp
COPY ./securellm-mcp .

# Install dependencies e build
RUN npm install && npm run build

# ============================================
# Production Image
# ============================================
FROM node:24-alpine

WORKDIR /app

# Copy built MCP from builder
COPY --from=builder /build/build ./build
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Runtime environment
ENV NODE_ENV=production
ENV PROJECT_ROOT=/app

# Expose via stdio (padrão MCP)
ENTRYPOINT ["node"]
CMD ["build/src/index.js"]
