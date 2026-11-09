# syntax=docker/dockerfile:1

# yoal-runner: the default job image for Yoal Pipelines (docs/PIPELINES.md §4.2, W5) and the image
# Yoal's own release workflow runs in (.yoal/workflows/publish.yml). Debian bookworm-slim plus
# what a typical job expects: git, curl, tar/gzip/unzip, jq, Node LTS, a pinned Bun and gh.
#
# Not in here on purpose:
# - yoal-step: the runner bind-mounts it read-only into every job container.
# - buildctl: the per-job BuildKit sidecar (W6) mounts it at /yoal/bin with BUILDKIT_HOST set.
# - buildah: the W6 fallback; install it in a job (apt-get install buildah) only where needed.
#
# Built and pushed per architecture by .yoal/workflows/runner-image.yml, then joined into one
# multi-arch tag with yoal/image-index.
ARG DEBIAN=debian:bookworm-slim
FROM ${DEBIAN}

ARG NODE_MAJOR=22
ARG BUN_VERSION=1.4.4
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
	LANG=C.UTF-8 \
	BUN_INSTALL=/usr/local \
	PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates curl git gnupg jq openssh-client tar gzip unzip xz-utils zstd \
		make python3 procps; \
	install -d -m 0755 /etc/apt/keyrings; \
	# Node LTS from NodeSource.
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list; \
	# GitHub CLI (the release job publishes with gh).
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg; \
	chmod a+r /etc/apt/keyrings/githubcli.gpg; \
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
	apt-get update; \
	apt-get install -y --no-install-recommends nodejs gh; \
	rm -rf /var/lib/apt/lists/*

# Bun, pinned (the release must build with exactly this version).
RUN set -eux; \
	case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
		amd64) asset=bun-linux-x64 ;; \
		arm64) asset=bun-linux-aarch64 ;; \
		*) echo "unsupported architecture" >&2; exit 1 ;; \
	esac; \
	curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}.zip"; \
	unzip -q /tmp/bun.zip -d /tmp; \
	install -m 0755 "/tmp/${asset}/bun" /usr/local/bin/bun; \
	ln -s bun /usr/local/bin/bunx; \
	rm -rf /tmp/bun.zip "/tmp/${asset}"; \
	bun --version | grep -qx "${BUN_VERSION}"; \
	node --version; gh --version; git --version; jq --version

# Jobs run as an unprivileged user (the job container maps it into its own user namespace).
RUN useradd --create-home --uid 1001 --shell /bin/bash runner
WORKDIR /workspace
LABEL org.opencontainers.image.title="yoal-runner" \
	org.opencontainers.image.description="Default job image for Yoal Pipelines"
