# Yoal Postgres variant images (D126): the pinned pgvector build of the official Postgres image
# plus one extension from the PGDG apt repository the base already configures. Same entrypoint,
# uid handling and data layout as the base, so the helper runs them under the same lockdown.
#
#   docker build -f docker/postgres/Dockerfile --build-arg VARIANT=postgis docker/postgres
#
# Published as ghcr.io/<owner>/yoal-postgres:<major>-<variant>-<revision>. Bump the revision in
# the contract, the helper and .github/workflows/postgres-images.yml whenever this file or the
# base changes, so a published tag never moves.
ARG BASE=docker.io/pgvector/pgvector:0.8.7-pg18-trixie
FROM ${BASE}

ARG VARIANT
RUN set -eux; \
	case "${VARIANT}" in \
		postgis) packages="postgresql-${PG_MAJOR}-postgis-3 postgresql-${PG_MAJOR}-postgis-3-scripts" ;; \
		pg_cron) packages="postgresql-${PG_MAJOR}-cron" ;; \
		*) echo "VARIANT must be postgis or pg_cron" >&2; exit 1 ;; \
	esac; \
	apt-get update; \
	apt-get install -y --no-install-recommends ${packages}; \
	rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.description="Yoal managed Postgres (${VARIANT} variant)"
