FROM openpolicyagent/opa:1.5.1-static@sha256:72c5186ef74bc7a88faf88204109476be41cdc392ff1de722f7d8ecb08f18c4d AS opa

FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c AS runtime
COPY --from=opa /opa /usr/local/bin/opa
COPY --chmod=0555 infra/compose/opa-entrypoint.sh /usr/local/bin/opa-entrypoint
USER 10001
ENTRYPOINT ["/usr/local/bin/opa-entrypoint"]
