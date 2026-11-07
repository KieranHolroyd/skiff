
/**
 * The Postgres image a PITR-enabled database runs (docs/PITR.md): the pinned pgvector image plus
 * pgBackRest, built from `docker/postgres-pitr/Dockerfile` and published by
 * `.github/workflows/postgres-pitr-image.yml`. Postgres runs `archive_command` in its own
 * container, so only this image can archive WAL; 16/17 (alpine) and the D126 variants have no
 * PITR build yet. The tag is immutable (the workflow never overwrites one); once published, the
 * digest is pinned here and in the contract (`POSTGRES_PITR_IMAGE_DIGEST`). Same uid, entrypoint
 * and lockdown as the base image.
 */
export const POSTGRES_PITR_VERSIONS = ['18'] as const;
const POSTGRES_PITR_IMAGE = 'ghcr.io/kieranholroyd/skiff-postgres-pitr';
const POSTGRES_PITR_IMAGE_REVISION = '1';
const POSTGRES_PITR_IMAGE_DIGEST: string | null = null;

/** The PITR image for a Postgres major version; the contract's `postgresPitrImage` must agree. */
export function postgresPitrImage(version: string): string {
	if (!(POSTGRES_PITR_VERSIONS as readonly string[]).includes(version))
		throw new ValidationError(`PITR needs Postgres ${POSTGRES_PITR_VERSIONS.join(', ')}; ${version} has no pgBackRest image`);
	const tag = `${POSTGRES_PITR_IMAGE}:${version}-${POSTGRES_PITR_IMAGE_REVISION}`;
	return POSTGRES_PITR_IMAGE_DIGEST ? `${tag}@${POSTGRES_PITR_IMAGE_DIGEST}` : tag;
}

