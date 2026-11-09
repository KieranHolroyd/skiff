# syntax=docker/dockerfile:1

# Yoal node image: the agent plus the Caddy binary it drives, in one container.
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
      apps/agent/src/main.ts --outfile /out/yoal-agent

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

ARG YOAL_VERSION=dev

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 yoal \
 && useradd --uid 10001 --gid yoal --home-dir /var/lib/yoal \
      --no-create-home --shell /usr/sbin/nologin yoal \
 && mkdir -p /var/lib/yoal/agent /var/lib/yoal/caddy/data /var/lib/yoal/caddy/config \
      /run/yoal /etc/caddy \
 && chown -R yoal:yoal /var/lib/yoal /run/yoal

COPY --from=agent /out/yoal-agent /opt/yoal/yoal-agent
COPY --from=caddy /out/caddy /opt/yoal/caddy
COPY docker/node/entrypoint.sh /usr/local/bin/yoal-node
COPY docker/node/yoal.Caddyfile /etc/caddy/yoal.Caddyfile

RUN chmod 0755 /opt/yoal/yoal-agent /opt/yoal/caddy /usr/local/bin/yoal-node

USER yoal

# The agent defaults; the controller is set at deploy time.
ENV NODE_ENV=production \
    HOME=/var/lib/yoal \
    XDG_DATA_HOME=/var/lib/yoal/caddy/data \
    XDG_CONFIG_HOME=/var/lib/yoal/caddy/config \
    YOAL_DATA_DIR=/var/lib/yoal/agent \
    YOAL_AGENT_VERSION=${YOAL_VERSION} \
    YOAL_CADDY_ADMIN_SOCKET=/run/yoal/caddy-admin.sock \
    YOAL_AGENT_SOCKET=/run/yoal/agent.sock \
    YOAL_CERT_PROBE_ADDR=off

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/yoal-node"]
