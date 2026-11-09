# syntax=docker/dockerfile:1

# Yoal Postgres for point-in-time recovery (docs/PITR.md): the pinned pgvector image Postgres 18
# runs on (D124) plus pgBackRest from the PostgreSQL (PGDG) apt repository the base image already
# trusts. Postgres runs `archive_command` inside its own container, so the binary has to be here;
# base backups, `info` and restores run the same binary, so the WAL writer and the restorer are
# always one pgBackRest version.
#
# Nothing else changes: same entrypoint, same Postgres build, same extensions. The helper runs the
# container as uid 70 under a read-only root (the entrypoint maps the uid with nss_wrapper), so the
# package's own spool/log/lock dirs are unused; Yoal's generated config points them at /data and
# /tmp.
#
# Published by .github/workflows/postgres-pitr-image.yml as
# ghcr.io/<owner>/yoal-postgres-pitr:<major>-<revision>. Bump POSTGRES_PITR_IMAGE_REVISION (in
# packages/contracts/src/database.ts and apps/helper/src/validate.ts) whenever this file, its base
# digest or the pgBackRest version changes: a published tag is never overwritten.

ARG BASE_IMAGE=docker.io/pgvector/pgvector:0.8.7-pg18-trixie@sha256:5895949dfcdf308eb0cd31c950c93c14895c77f33fbedfecf1fa511ab1d4bcd2
FROM ${BASE_IMAGE}

# The exact PGDG build. A version the repository has dropped fails the build rather than
# silently installing another one.
ARG PGBACKREST_VERSION=2.60.0-1.pgdg13+1

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}" ca-certificates; \
	rm -rf /var/lib/apt/lists/*; \
	# The rendered archive_command calls this absolute path on every Yoal Postgres image.
	ln -sf /usr/bin/pgbackrest /usr/local/bin/pgbackrest; \
	# Yoal mounts its generated config directory here read-only; the package's sample is unused.
	rm -rf /etc/pgbackrest /etc/pgbackrest.conf; \
	mkdir -p /etc/pgbackrest; \
	pgbackrest version; \
	postgres --version

LABEL org.opencontainers.image.title="yoal-postgres-pitr" \
	org.opencontainers.image.description="pgvector Postgres 18 with pgBackRest for Yoal point-in-time recovery"
