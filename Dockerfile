FROM rust:1.97-slim-bookworm AS build
WORKDIR /build

COPY rust/Cargo.toml rust/Cargo.lock ./rust/
COPY rust/src ./rust/src
RUN cargo build --locked --release --manifest-path rust/Cargo.toml

FROM debian:bookworm-slim AS runtime

WORKDIR /app
COPY --from=build /build/rust/target/release/open-claude-router /usr/local/bin/open-claude-router
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY LICENSE ./LICENSE

ENV PORT=3457
ENV HOST=0.0.0.0
ENV RUST_LOG=info
RUN mkdir -p /app/logs && chown 65532:65532 /app/logs
VOLUME ["/app/logs"]
EXPOSE 3457
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/open-claude-router"]
