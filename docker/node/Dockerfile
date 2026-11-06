# syntax=docker/dockerfile:1

# Skiff node image: the agent plus the Caddy binary it drives, in one container.
# This serves the agent's static release path (agent release cache + Caddy); the
# tier-2/3 systemd workloads still require a host install.
#
# Both binaries are cross-compiled from the build platform, so a multi-arch
# build does not run a compiler under QEMU.

ARG BUN_VERSION=1.4.4
ARG CADDY_VERSION=2.11.7
ARG CADDY_DNS_CLOUDFLARE_VERSION=v0.2.4

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS agent
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=x64 ;; \
      arm64) target=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    bun build --compile --minify --target=bun-linux-$target \
      apps/agent/src/main.ts --outfile /out/skiff-agent

FROM --platform=$BUILDPLATFORM caddy:${CADDY_VERSION}-builder AS caddy
ARG CADDY_VERSION
ARG CADDY_DNS_CLOUDFLARE_VERSION
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    # The builder image sets XCADDY_SETCAP=1, which stamps cap_net_bind_service on the binary.
    # Under compose's cap_drop: ALL + no-new-privileges the kernel then refuses to exec it
    # ("Operation not permitted"). Caddy listens on :8080, so it needs no capability.
    CGO_ENABLED=0 GOOS=linux GOARCH=$goarch XCADDY_SETCAP=0 \
      xcaddy build v${CADDY_VERSION} \
        --with github.com/caddy-dns/cloudflare@${CADDY_DNS_CLOUDFLARE_VERSION} \
        --output /out/caddy

FROM debian:bookworm-slim

ARG SKIFF_VERSION=dev

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 skiff \
 && useradd --uid 10001 --gid skiff --home-dir /var/lib/skiff \
      --no-create-home --shell /usr/sbin/nologin skiff \
 && mkdir -p /var/lib/skiff/agent /var/lib/skiff/caddy/data /var/lib/skiff/caddy/config \
      /run/skiff /etc/caddy \
 && chown -R skiff:skiff /var/lib/skiff /run/skiff

COPY --from=agent /out/skiff-agent /opt/skiff/skiff-agent
COPY --from=caddy /out/caddy /opt/skiff/caddy
COPY docker/node/entrypoint.sh /usr/local/bin/skiff-node
COPY docker/node/skiff.Caddyfile /etc/caddy/skiff.Caddyfile

RUN chmod 0755 /opt/skiff/skiff-agent /opt/skiff/caddy /usr/local/bin/skiff-node

USER skiff

# The agent defaults; the controller is set at deploy time.
ENV NODE_ENV=production \
    HOME=/var/lib/skiff \
    XDG_DATA_HOME=/var/lib/skiff/caddy/data \
    XDG_CONFIG_HOME=/var/lib/skiff/caddy/config \
    SKIFF_DATA_DIR=/var/lib/skiff/agent \
    SKIFF_AGENT_VERSION=${SKIFF_VERSION} \
    SKIFF_CADDY_ADMIN_SOCKET=/run/skiff/caddy-admin.sock \
    SKIFF_AGENT_SOCKET=/run/skiff/agent.sock \
    SKIFF_CERT_PROBE_ADDR=off

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/skiff-node"]
