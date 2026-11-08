import { promises as fs } from 'node:fs';

/**
 * Volume inventory and verification for the privileged helper (docs/VOLUMES.md, D72–D80).
 *
 * The helper reads `findmnt`/`lsblk` output and derives stable source keys — never device names.
 * Before a managed workload starts, `verifyVolume` proves that the registered mount path really is
 * the expected filesystem; a missing mount must fail the start instead of writing to the root
 * disk through an empty directory (D76).
 *
 * This module deliberately imports nothing from `@skiff/contracts` (the helper ships without
 * runtime dependencies and validates its own wire surface).
 */

export const VOLUME_KINDS = ['filesystem', 'lvm', 'mdadm', 'zfs', 'luks', 'nfs', 'cifs'] as const;
export type VolumeKind = (typeof VOLUME_KINDS)[number];

export interface HelperMount {
	sourceKey: string;
	kind: VolumeKind;
	fsType: string;
	mountPath: string;
	device: string | null;
	label: string | null;
	sizeBytes: number;
	freeBytes: number;
	remote: boolean;
	/** The block device behind it spins (lsblk ROTA); null for network and pool filesystems. */
	rotational: boolean | null;
}

export interface HelperDevice {
	id: string;
	name: string;
	type: string;
	/** Kernel name of the device this one sits on (a partition's disk). */
	parent: string | null;
	model: string | null;
	serial: string | null;
	sizeBytes: number;
	fsType: string | null;
	/** Filesystem UUID. */
	uuid: string | null;
	label: string | null;
	mountPath: string | null;
	holders: string[];
	/** lsblk ROTA: a spinning disk (bulk) or not (SSD/NVMe, fast). */
	rotational: boolean | null;
	free: boolean;
}

export interface HelperInventory {
	generatedAt: string;
	mounts: HelperMount[];
	devices: HelperDevice[];
}

/** A volume in the node's desired state; the helper writes these to its registry. */
export interface WorkloadVolume {
	id: string;
	mountPath: string;
	sourceKey: string;
	fsType: string;
}

const FORBIDDEN_EXACT = new Set([
	'/',
	'/bin',
	'/boot',
	'/data',
	'/dev',
	'/etc',
	'/home',
	'/lib',
	'/lib64',
	'/media',
	'/mnt',
	'/opt',
	'/opt/skiff',
	'/proc',
	'/root',
	'/run',
	'/sbin',
	'/snap',
	'/srv',
	'/srv/skiff',
	'/sys',
	'/tmp',
	'/usr',
	'/var',
	'/var/lib',
	'/var/lib/skiff',
	'/var/log',
	'/var/tmp',
]);

const FORBIDDEN_PREFIXES = [
	'/bin/',
	'/boot/',
	'/dev/',
	'/etc/',
	'/home/',
	'/lib/',
	'/lib64/',
	'/opt/skiff/',
	'/proc/',
	'/root/',
	'/run/',
	'/sbin/',
	'/snap/',
	'/sys/',
	'/tmp/',
	'/usr/',
	'/var/lib/skiff/',
	'/var/log/',
	'/var/tmp/',
];

/** Why `path` cannot be a volume mount path, or null. Mirrors the contract's path rules. */
export function volumePathProblem(path: string): string | null {
	if (!path.startsWith('/')) return 'Volume mount paths must be absolute.';
	if (path.length > 200) return 'Keep the volume mount path under 200 characters.';
	if (!/^[A-Za-z0-9._/-]+$/.test(path)) return 'Use only letters, digits, ".", "_", "-" and "/".';
	if (path !== '/' && path.endsWith('/')) return 'Drop the trailing slash.';
	if (path.split('/').some((part, index) => (index > 0 && part === '') || part === '.' || part === '..'))
		return 'Use a normalized path, without "//", "." or "..".';
	if (FORBIDDEN_EXACT.has(path)) return `${path} is too broad or reserved; use a directory inside it.`;
	const prefix = FORBIDDEN_PREFIXES.find((candidate) => path.startsWith(candidate));
	if (prefix) return `${path} is inside ${prefix}, which cannot hold workload data.`;
	return null;
}

/** Validate the volume list from desired state before it reaches the registry file. */
export function parseWorkloadVolumes(raw: unknown): WorkloadVolume[] {
	if (!Array.isArray(raw)) throw new Error('volumes must be an array');
	const out: WorkloadVolume[] = [];
	const ids = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'object' || item === null || Array.isArray(item))
			throw new Error('each volume must be an object');
		const record = item as Record<string, unknown>;
		const id = record.id;
		const mountPath = record.mountPath;
		const sourceKey = record.sourceKey;
		const fsType = record.fsType;
		if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))
			throw new Error('volume id must match [A-Za-z0-9_-]{1,100}');
		if (ids.has(id)) throw new Error(`duplicate volume id ${id}`);
		ids.add(id);
		if (typeof mountPath !== 'string') throw new Error(`volume ${id}: mountPath must be a string`);
		const problem = volumePathProblem(mountPath);
		if (problem) throw new Error(`volume ${id}: ${problem}`);
		if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9._:/#+@-]{3,300}$/.test(sourceKey) || sourceKey.startsWith('/'))
			throw new Error(`volume ${id}: sourceKey must be a stable identity, not a device path`);
		if (typeof fsType !== 'string' || fsType.length === 0 || fsType.length > 32)
			throw new Error(`volume ${id}: fsType is invalid`);
		out.push({ id, mountPath, sourceKey, fsType });
	}
	return out;
}

/** `/etc/skiff/volumes.json`, written by the root volume applier. */
export interface VolumeRegistryEntry {
	mountPath: string;
	sourceKey: string;
	fsType: string;
}
export type VolumeRegistry = Record<string, VolumeRegistryEntry>;

export const DEFAULT_VOLUMES_FILE = '/etc/skiff/volumes.json';

/** Filesystems that can host managed data. Everything else (`tmpfs`, `proc`, `overlay`, …) is noise. */
const LOCAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'ntfs', 'exfat', 'vfat', 'zfs']);
const NETWORK_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3']);

interface RawRecord {
	[key: string]: unknown;
}

function field(record: RawRecord, ...names: string[]): unknown {
	for (const name of names) {
		if (record[name] !== undefined) return record[name];
		if (record[name.toUpperCase()] !== undefined) return record[name.toUpperCase()];
	}
	return undefined;
}

function text(record: RawRecord, ...names: string[]): string | null {
	const value = field(record, ...names);
	if (typeof value === 'string') return value.length > 0 ? value : null;
	if (typeof value === 'number') return String(value);
	return null;
}

function bytes(record: RawRecord, ...names: string[]): number {
	const value = field(record, ...names);
	if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
	return 0;
}

/** lsblk prints ROTA as `true`/`false` (util-linux ≥ 2.33) or `"1"`/`"0"`. */
function flag(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value;
	if (value === '1' || value === 1) return true;
	if (value === '0' || value === 0) return false;
	return null;
}

function array(value: unknown): RawRecord[] {
	return Array.isArray(value) ? value.filter((item): item is RawRecord => typeof item === 'object' && item !== null) : [];
}

function normalizePath(path: string): string {
	if (path === '/') return path;
	return path.replace(/\/+$/, '');
}

// ------------------------------------------------------------------ parsing

export interface FindmntEntry {
	mountPath: string;
	source: string;
	fsType: string;
	uuid: string | null;
	label: string | null;
	sizeBytes: number;
	freeBytes: number;
	options: string;
}

/** Parse `findmnt -J -b -o TARGET,SOURCE,FSTYPE,UUID,LABEL,SIZE,AVAIL,OPTIONS`. */
export function parseFindmnt(stdout: string): FindmntEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const root = parsed as RawRecord;
	const rows = array(field(root, 'filesystems', 'Filesystems')).length
		? array(field(root, 'filesystems', 'Filesystems'))
		: array(parsed);
	return rows.flatMap((row) => {
		const mountPath = text(row, 'target', 'Target');
		const source = text(row, 'source', 'Source');
		const fsType = text(row, 'fstype', 'Fstype');
		if (!mountPath || !source || !fsType) return [];
		return [
			{
				mountPath: normalizePath(mountPath),
				source,
				fsType: fsType.toLowerCase(),
				uuid: text(row, 'uuid', 'UUID'),
				label: text(row, 'label', 'Label'),
				sizeBytes: bytes(row, 'size', 'Size'),
				freeBytes: bytes(row, 'avail', 'Avail'),
				options: text(row, 'options', 'Options') ?? '',
			},
		];
	});
}

export interface LsblkNode {
	name: string;
	kname: string;
	type: string;
	uuid: string | null;
	label: string | null;
	mountPath: string | null;
	serial: string | null;
	model: string | null;
	sizeBytes: number;
	fsType: string | null;
	rotational: boolean | null;
	children: LsblkNode[];
}

/** Parse `lsblk -J -b -o NAME,KNAME,TYPE,UUID,LABEL,MOUNTPOINT,SERIAL,MODEL,SIZE,FSTYPE,ROTA`. */
export function parseLsblk(stdout: string): LsblkNode[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const root = parsed as RawRecord;
	const rows = array(field(root, 'blockdevices', 'Blockdevices'));
	const walk = (row: RawRecord): LsblkNode | null => {
		const name = text(row, 'name', 'Name');
		if (!name) return null;
		return {
			name,
			kname: text(row, 'kname', 'Kname') ?? name,
			type: (text(row, 'type', 'Type') ?? '').toLowerCase(),
			uuid: text(row, 'uuid', 'UUID'),
			label: text(row, 'label', 'Label'),
			mountPath: text(row, 'mountpoint', 'Mountpoint'),
			serial: text(row, 'serial', 'Serial'),
			model: text(row, 'model', 'Model'),
			sizeBytes: bytes(row, 'size', 'Size'),
			fsType: text(row, 'fstype', 'Fstype'),
			rotational: flag(field(row, 'rota', 'Rota')),
			children: array(field(row, 'children', 'Children'))
				.map(walk)
				.filter((node): node is LsblkNode => node !== null),
		};
	};
	return rows.map(walk).filter((node): node is LsblkNode => node !== null);
}

// ------------------------------------------------------------------ identity

/** Map `/dev/sda1`, `/dev/mapper/vg-lv`, `md0`, … to the lsblk node that describes it. */
function deviceIndex(nodes: LsblkNode[]): Map<string, LsblkNode> {
	const index = new Map<string, LsblkNode>();
	const add = (node: LsblkNode): void => {
		for (const key of [
			node.name,
			node.kname,
			`/dev/${node.name}`,
			`/dev/${node.kname}`,
			`/dev/mapper/${node.name}`,
			`/dev/mapper/${node.kname}`,
		])
			index.set(key, node);
		for (const child of node.children) add(child);
	};
	for (const node of nodes) add(node);
	return index;
}

function btrfsSubvolume(options: string): string | null {
	const match = /(?:^|,)subvol=([^,]+)/.exec(options);
	return match?.[1] ?? null;
}

/** Derive the stable identity and kind for one mount. Null means Skiff must not manage it. */
export function classifyMount(
	entry: FindmntEntry,
	devices: Map<string, LsblkNode>,
): { kind: VolumeKind; sourceKey: string } | null {
	const network = NETWORK_FS.has(entry.fsType);
	if (network) {
		if (entry.fsType.startsWith('nfs')) {
			const [server, ...rest] = entry.source.split(':');
			const exported = rest.join(':');
			if (!server || !exported) return null;
			return { kind: 'nfs', sourceKey: `nfs:${server}:${normalizePath(exported) || '/'}` };
		}
		const match = /^\/\/([^/]+)\/(.+)$/.exec(entry.source);
		if (!match) return null;
		return { kind: 'cifs', sourceKey: `cifs:${match[1]}/${match[2]!.replace(/\/+$/, '')}` };
	}
	if (!LOCAL_FS.has(entry.fsType)) return null;
	if (entry.fsType === 'zfs') {
		return { kind: 'zfs', sourceKey: `zfs:${entry.source.replace(/^\/+/, '')}` };
	}
	const node = devices.get(entry.source);
	if (node?.type === 'crypt') return { kind: 'luks', sourceKey: `luks:${node.name}` };
	if (node?.type === 'lvm') return { kind: 'lvm', sourceKey: `lvm:${node.name}` };
	if (node?.type.startsWith('raid'))
		return { kind: 'mdadm', sourceKey: `md:${node.uuid ?? node.name}` };
	if (!entry.uuid) return null;
	const subvolume = entry.fsType === 'btrfs' ? btrfsSubvolume(entry.options) : null;
	return { kind: 'filesystem', sourceKey: `fs:${entry.uuid}${subvolume ? `#${subvolume}` : ''}` };
}

/** Mounts the node can offer for adoption, with stable source keys and current capacity. */
export function inventoryFrom(
	findmnt: FindmntEntry[],
	lsblk: LsblkNode[],
	now: Date = new Date(),
): HelperInventory {
	const devices = deviceIndex(lsblk);
	const mounts: HelperMount[] = [];
	const seen = new Set<string>();
	for (const entry of findmnt) {
		// The inventory is the list of adoptable data volumes. Root, /var/lib/skiff and the other
		// reserved paths cannot hold node data (the contract rejects them), so never advertise them.
		if (volumePathProblem(entry.mountPath)) continue;
		const identity = classifyMount(entry, devices);
		if (!identity || seen.has(identity.sourceKey)) continue;
		seen.add(identity.sourceKey);
		mounts.push({
			sourceKey: identity.sourceKey,
			kind: identity.kind,
			fsType: entry.fsType,
			mountPath: entry.mountPath,
			device: entry.source,
			label: entry.label,
			sizeBytes: entry.sizeBytes,
			freeBytes: entry.freeBytes,
			remote: NETWORK_FS.has(entry.fsType),
			rotational: NETWORK_FS.has(entry.fsType) ? null : (devices.get(entry.source)?.rotational ?? null),
		});
	}
	mounts.sort((a, b) => a.mountPath.localeCompare(b.mountPath));
	return { generatedAt: now.toISOString(), mounts, devices: freeDevices(lsblk) };
}

/** Device types reported to the control plane; loop, rom and zram noise is left out. */
function reportedType(type: string): boolean {
	return type === 'disk' || type === 'part' || type === 'lvm' || type === 'crypt' || type.startsWith('raid');
}

function freeDevices(nodes: LsblkNode[]): HelperDevice[] {
	const out: HelperDevice[] = [];
	const seen = new Set<string>();
	const walk = (node: LsblkNode, parent: LsblkNode | null): void => {
		// A RAID array or LV shared by several members appears under each; report it once.
		if (reportedType(node.type) && !/^(zram|loop|ram)\d/.test(node.name) && !seen.has(node.kname)) {
			seen.add(node.kname);
			const holders = node.children.map((child) => child.name);
			const used =
				node.mountPath !== null ||
				node.fsType !== null ||
				node.uuid !== null ||
				node.children.length > 0 ||
				['crypt', 'lvm', 'zfs_member'].includes(node.type) ||
				node.type.startsWith('raid');
			out.push({
				id: node.serial ?? `dev:${node.name}`,
				name: node.type === 'lvm' || node.type === 'crypt' ? `/dev/mapper/${node.name}` : `/dev/${node.name}`,
				type: node.type,
				parent: parent?.name ?? null,
				model: node.model,
				serial: node.serial,
				sizeBytes: node.sizeBytes,
				fsType: node.fsType,
				uuid: node.uuid,
				label: node.label,
				mountPath: node.mountPath === null ? null : node.mountPath === '[SWAP]' ? node.mountPath : normalizePath(node.mountPath),
				holders,
				rotational: node.rotational,
				free: !used,
			});
		}
		for (const child of node.children) walk(child, node);
	};
	for (const node of nodes) walk(node, null);
	return out;
}

// ------------------------------------------------------------------ verification

export interface VerifyResult {
	ok: boolean;
	mountPath: string | null;
	sourceKey: string | null;
	message: string | null;
}

/** Find the mount entry for `mountPath`, or null when the path is not a mountpoint of its own. */
export function mountAt(entries: FindmntEntry[], mountPath: string): FindmntEntry | null {
	const expected = normalizePath(mountPath);
	return entries.find((candidate) => candidate.mountPath === expected) ?? null;
}

/** Compare what `findmnt` reports for `mountPath` with the key Skiff registered. */
export function verifyFrom(
	findmntStdout: string,
	lsblkStdout: string,
	mountPath: string,
	expectedSourceKey: string,
): VerifyResult {
	const entries = parseFindmnt(findmntStdout);
	const expected = normalizePath(mountPath);
	const entry = mountAt(entries, expected);
	if (!entry)
		return {
			ok: false,
			mountPath: entries[0]?.mountPath ?? null,
			sourceKey: null,
			message: `Nothing is mounted at ${expected}.`,
		};
	const identity = classifyMount(entry, deviceIndex(parseLsblk(lsblkStdout)));
	if (!identity)
		return {
			ok: false,
			mountPath: entry.mountPath,
			sourceKey: null,
			message: `Unsupported filesystem ${entry.fsType}.`,
		};
	return {
		ok: identity.sourceKey === expectedSourceKey,
		mountPath: entry.mountPath,
		sourceKey: identity.sourceKey,
		message:
			identity.sourceKey === expectedSourceKey
				? null
				: `${expected} is ${identity.sourceKey}, but the volume is ${expectedSourceKey}.`,
	};
}

// ------------------------------------------------------------------ registry

function parseRegistry(value: unknown): VolumeRegistry {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	const registry: VolumeRegistry = {};
	for (const [id, raw] of Object.entries(value)) {
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
		const record = raw as Record<string, unknown>;
		const mountPath = record.mountPath;
		const sourceKey = record.sourceKey;
		const fsType = record.fsType;
		if (typeof mountPath !== 'string' || volumePathProblem(mountPath)) continue;
		if (typeof sourceKey !== 'string' || sourceKey.length === 0 || sourceKey.startsWith('/')) continue;
		if (typeof fsType !== 'string' || fsType.length === 0) continue;
		registry[id] = { mountPath, sourceKey, fsType };
	}
	return registry;
}

/** Read the root applier's volume registry. A missing file means no volume-backed workloads yet. */
export async function readVolumeRegistry(path: string): Promise<VolumeRegistry> {
	try {
		const text = await fs.readFile(path, 'utf8');
		return parseRegistry(JSON.parse(text));
	} catch {
		return {};
	}
}

// ------------------------------------------------------------------ command wrappers

/** The subset of the helper's injected command runner used here (argv only, never a shell). */
export interface VolumeRunner {
	run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const FINDMNT = '/usr/bin/findmnt';
export const LSBLK = '/usr/bin/lsblk';
const FINDMNT_ARGS = ['-J', '-b', '-o', 'TARGET,SOURCE,FSTYPE,UUID,LABEL,SIZE,AVAIL,OPTIONS'];
const LSBLK_ARGS = ['-J', '-b', '-o', 'NAME,KNAME,TYPE,UUID,LABEL,MOUNTPOINT,SERIAL,MODEL,SIZE,FSTYPE,ROTA'];

/** Read the current mounts and block devices. Read-only; safe to call every minute. */
export async function readInventory(runner: VolumeRunner, now: Date = new Date()): Promise<HelperInventory> {
	const [findmnt, lsblk] = await Promise.all([
		runner.run([FINDMNT, ...FINDMNT_ARGS]),
		runner.run([LSBLK, ...LSBLK_ARGS]),
	]);
	return inventoryFrom(parseFindmnt(findmnt.stdout), parseLsblk(lsblk.stdout), now);
}

/** Prove that `mountPath` is the registered filesystem, not the root disk behind an empty dir. */
export async function verifyMount(
	runner: VolumeRunner,
	mountPath: string,
	sourceKey: string,
): Promise<VerifyResult> {
	const [findmnt, lsblk] = await Promise.all([
		runner.run([FINDMNT, ...FINDMNT_ARGS]),
		runner.run([LSBLK, ...LSBLK_ARGS]),
	]);
	if (!findmnt.stdout)
		return {
			ok: false,
			mountPath: null,
			sourceKey: null,
			message: `Could not read mounts (${findmnt.stderr.trim() || `exit ${findmnt.code}`}).`,
		};
	return verifyFrom(findmnt.stdout, lsblk.stdout, mountPath, sourceKey);
}
