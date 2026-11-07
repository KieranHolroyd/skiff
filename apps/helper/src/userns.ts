import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { ValidationError } from './validate.ts';

/**
 * Subordinate ids for rootful Podman's `--userns=auto` (Quadlet `UserNS=auto`). Podman carves each
 * container's range out of the entry for the `containers` user in /etc/subuid and /etc/subgid; with
 * no entry it refuses to start the container. The range is the one Podman's documentation suggests:
 * the top half of the 32-bit id space, far above any account or a rootless user's own range, so a
 * container's uid 0 is an id nothing on the host owns.
 */
export const CONTAINERS_SUBID_USER = 'containers';
export const CONTAINERS_SUBID_START = 2_147_483_647;
export const CONTAINERS_SUBID_COUNT = 2_147_483_648;

export interface SubidFiles {
	subuid: string;
	subgid: string;
}

export const DEFAULT_SUBID_FILES: SubidFiles = { subuid: '/etc/subuid', subgid: '/etc/subgid' };

interface SubidEntry {
	user: string;
	start: number;
	count: number;
}

function parseEntries(text: string): SubidEntry[] {
	const entries: SubidEntry[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const [user, start, count] = line.split(':');
		const from = Number(start);
		const size = Number(count);
		if (!user || !Number.isSafeInteger(from) || !Number.isSafeInteger(size)) continue;
		entries.push({ user, start: from, count: size });
	}
	return entries;
}

/**
 * The file with a `containers` range appended, or null when it already has one (an operator's own
 * entry is kept as it is). Refuses to append over another user's range: two owners of one host id
 * would undo the isolation the namespace is for.
 */
export function withContainersSubids(text: string, label: string): string | null {
	const entries = parseEntries(text);
	if (entries.some((entry) => entry.user === CONTAINERS_SUBID_USER)) return null;
	const end = CONTAINERS_SUBID_START + CONTAINERS_SUBID_COUNT;
	const clash = entries.find((entry) => entry.start < end && entry.start + entry.count > CONTAINERS_SUBID_START);
	if (clash)
		throw new ValidationError(
			`${label} gives ${clash.user} ids that overlap the range Skiff reserves for containers ` +
				`(${CONTAINERS_SUBID_START}-${end - 1}); add a "${CONTAINERS_SUBID_USER}:<start>:<count>" entry by hand`,
		);
	const line = `${CONTAINERS_SUBID_USER}:${CONTAINERS_SUBID_START}:${CONTAINERS_SUBID_COUNT}\n`;
	return text === '' || text.endsWith('\n') ? `${text}${line}` : `${text}\n${line}`;
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	}
}

/**
 * Make sure both files carry the `containers` range before a `UserNS=auto` container starts.
 * Both files are checked before either is written, so an overlap in `subgid` cannot leave
 * `subuid` changed. Idempotent; returns whether anything was written. The replacement is atomic
 * and keeps the standard 0644 mode, since shadow-utils and Podman read these files as any user.
 */
export async function ensureContainerSubids(files: SubidFiles = DEFAULT_SUBID_FILES): Promise<boolean> {
	const planned: Array<{ path: string; next: string }> = [];
	for (const path of [files.subuid, files.subgid]) {
		const current = await readOrEmpty(path);
		const next = withContainersSubids(current, path);
		if (next !== null) planned.push({ path, next });
	}
	for (const { path, next } of planned) {
		// A unique suffix keeps two applies that race from sharing (and losing) one temp file.
		const temp = join(dirname(path), `.${path.split('/').pop()}.skiff-${process.pid}-${randomUUID()}`);
		await fs.writeFile(temp, next, { mode: 0o644 });
		await fs.rename(temp, path);
	}
	return planned.length > 0;
}
