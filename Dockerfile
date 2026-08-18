FROM rust:1.97-slim-bookworm AS build
WORKDIR /build

COPY rust/Cargo.toml rust/Cargo.lock ./rust/
COPY rust/src ./rust/src
COPY lens/Cargo.toml lens/Cargo.lock ./lens/
COPY lens/src ./lens/src
COPY lens/static ./lens/static
RUN cargo build --locked --release --manifest-path rust/Cargo.toml
RUN cargo build --locked --release --manifest-path lens/Cargo.toml

FROM debian:bookworm-slim AS runtime

WORKDIR /app
COPY --from=build /build/rust/target/release/open-claude-router /usr/local/bin/open-claude-router
COPY --from=build /build/lens/target/release/ocr-lens /usr/local/bin/ocr-lens
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY LICENSE ./LICENSE
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /app/logs /app/data

# Router (model forwarding) on 3457, lens dashboard on 3458. Publish only the
# ports you want reachable; bind-restrict them at `docker run` time (for
# example `-p 127.0.0.1:3458:3458`) — the image itself makes no assumptions
# about your network.
ENV PORT=3457
ENV HOST=0.0.0.0
ENV LENS_PORT=3458
ENV OCR_MODEL_LOG_DIR=/app/logs
ENV LENS_DB_PATH=/app/data/lens.db
# 32 MiB matches the router's inbound body limit so large Claude Code
# requests are captured whole and the dashboard can reconstruct them.
ENV OCR_MODEL_LOG_MAX_BODY_BYTES=33554432
ENV RUST_LOG=info

# The image ships bash but no curl/wget; probe over /dev/tcp. The router port
# is always checked; the lens port only when the dashboard is enabled.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bash", "-c", "check() { exec 3<>/dev/tcp/127.0.0.1/$1 && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q 'HTTP/1.[01] 200' <&3; }; check ${PORT:-3457} && { case \"${LENS_ENABLED:-true}\" in false|0|no|off) ;; *) check ${LENS_PORT:-3458};; esac; }"]

VOLUME ["/app/logs", "/app/data"]
EXPOSE 3457 3458
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
