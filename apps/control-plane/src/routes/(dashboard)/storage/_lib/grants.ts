import { storageGrantModes, type StorageGrant } from '@skiff/contracts';

/** Form field name for one bucket's grant in `GrantsFields`. */
export const GRANT_FIELD_PREFIX = 'grant:';

/**
 * Read `grant:<bucket>` fields (value `read`, `read-write`, or blank for no access) into the
 * grants list the attach/update schemas expect. Unknown modes are dropped; zod judges the rest.
 */
export function grantsFromForm(data: FormData): StorageGrant[] {
	const grants: StorageGrant[] = [];
	for (const [key, value] of data.entries()) {
		if (!key.startsWith(GRANT_FIELD_PREFIX) || typeof value !== 'string') continue;
		const mode = value.trim();
		if (!(storageGrantModes as readonly string[]).includes(mode)) continue;
		grants.push({ bucket: key.slice(GRANT_FIELD_PREFIX.length), mode: mode as StorageGrant['mode'] });
	}
	return grants;
}
