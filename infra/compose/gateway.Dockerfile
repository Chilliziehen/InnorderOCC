FROM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854

WORKDIR /app
COPY --chown=node:node infra/compose/gateway.mjs ./gateway.mjs
USER node
EXPOSE 5432 9092 6379 9000 9001 8181 3100 8080 18000
HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=20 CMD ["node", "-e", "fetch('http://localhost:18000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/gateway.mjs"]
