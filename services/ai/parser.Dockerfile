FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS dependencies
WORKDIR /build
COPY services/ai/parser-runtime/package.json services/ai/parser-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS runtime

ENV NODE_ENV=production \
    PARSER_WORKER_RUN=true \
    PARSER_INPUT_ROOT=/parser/input \
    PARSER_REQUEST_ROOT=/parser/requests \
    PARSER_OUTPUT_ROOT=/parser/output
WORKDIR /app
COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node services/ai/dist ./services/ai/dist
USER node
ENTRYPOINT ["node", "services/ai/dist/ingestion/parser-worker.js"]
