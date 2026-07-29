FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY services/ai/package.json services/ai/tsconfig.json ./services/ai/
COPY packages/contracts/src ./packages/contracts/src
COPY services/ai/src ./services/ai/src
RUN npm ci --ignore-scripts --include-workspace-root --workspace @innorder/contracts --workspace @innorder/ai-service
RUN npm run build --workspace @innorder/contracts \
    && npm run build --workspace @innorder/ai-service \
    && npm prune --omit=dev --ignore-scripts

FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS runtime

ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/package.json /workspace/package-lock.json ./
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /workspace/services/ai/package.json ./services/ai/package.json
COPY --from=build --chown=node:node /workspace/services/ai/dist ./services/ai/dist
USER node
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 CMD ["node", "-e", "fetch('http://localhost:3100/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "services/ai/dist/server.js"]
