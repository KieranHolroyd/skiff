import { promises as fs } from 'node:fs';
import { arch, cpus, release } from 'node:os';
import type { NodeHardware } from '@skiff/contracts';

/**
 * Hardware facts for placement (docs/CLUSTERING.md §3.1, phase C0).
 *
 * Discovery is read-only and local: no package install, no container, no driver load. A fact that
 * cannot be read is omitted rather than guessed. The block is cached for an hour because hardware
 * does not change, and a failed probe never replaces the last good block on the control plane.
 */

const REFRESH_MS = 60 * 60 * 1000;

export class HardwareCollector {
	private cached: NodeHardware | null = null;
	private collectedAt = 0;

	async collect(force = false): Promise<NodeHardware | null> {
		if (!force && this.cached && Date.now() - this.collectedAt < REFRESH_MS) return this.cached;
		try {
			const hardware = await collectHardware();
			this.cached = hardware;
			this.collectedAt = Date.now();
			return hardware;
		} catch {
			return this.cached;
		}
	}
}

export async function collectHardware(): Promise<NodeHardware> {
	const hardware: NodeHardware = {
		arch: arch(),
		os: await osName(),
		kernel: release(),
		collectedAt: new Date().toISOString(),
	};

	const cpu = await cpuFacts();
	if (cpu.cores !== undefined) hardware.cores = cpu.cores;
	if (cpu.threads !== undefined) hardware.threads = cpu.threads;
	if (cpu.model !== undefined) hardware.cpuModel = cpu.model;

	const memory = await memoryFacts();
	if (memory) {
		hardware.memoryBytes = memory.total;
		hardware.swapBytes = memory.swap;
	}

	const virtualization = await command(['systemd-detect-virt']);
	if (virtualization) hardware.virtualization = virtualization.trim().slice(0, 64);

	const gpus = await gpuFacts();
	if (gpus.length > 0) hardware.gpus = gpus;

	const disks = await diskFacts();
	if (disks.length > 0) hardware.disks = disks;

	const nics = await nicFacts();
	if (nics.length > 0) hardware.nics = nics;

	return hardware;
}

interface CpuFacts {
	cores?: number;
	threads?: number;
	model?: string;
}

/** `/proc/cpuinfo` gives the model and, on x86, physical core count; `os.cpus()` is the fallback. */
export async function cpuFacts(): Promise<CpuFacts> {
	const logical = cpus();
	const facts: CpuFacts = {};
	if (logical.length > 0) {
		facts.threads = logical.length;
		const model = logical[0]?.model?.trim();
		if (model) facts.model = model.slice(0, 160);
	}
	try {
		const text = await fs.readFile('/proc/cpuinfo', 'utf8');
		const cores = /^cpu cores\s*:\s*(\d+)/m.exec(text);
		if (cores?.[1]) facts.cores = Math.max(1, Number(cores[1]));
		else if (logical.length > 0) facts.cores = logical.length;
		const model = /^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.trim();
		if (model) facts.model = model.slice(0, 160);
	} catch {
		if (logical.length > 0) facts.cores = logical.length;
	}
	return facts;
}

/** Total RAM and swap in bytes from `/proc/meminfo`. */
export async function memoryFacts(): Promise<{ total: number; swap: number } | null> {
	try {
		const text = await fs.readFile('/proc/meminfo', 'utf8');
		const values = new Map<string, number>();
		for (const line of text.split('\n')) {
			const match = /^([A-Za-z_()]+):\s+(\d+)/.exec(line);
			if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
		}
		const total = values.get('MemTotal');
		if (!total) return null;
		return { total, swap: values.get('SwapTotal') ?? 0 };
	} catch {
		return null;
	}
}

/** `nvidia-smi` first, then any DRM render node as a nameless fallback. */
export async function gpuFacts(): Promise<NonNullable<NodeHardware['gpus']>> {
	const output = await command([
		'nvidia-smi',
		'--query-gpu=name,memory.total,pci.bus_id',
		'--format=csv,noheader,nounits',
	]);
	if (output) {
		const gpus = output
			.split('\n')
			.map((line) => line.split(',').map((part) => part.trim()))
			.filter((parts) => parts.length >= 3 && parts[0])
			.map((parts) => ({
				name: parts[0]!.slice(0, 160),
				memoryMiB: Number.isFinite(Number(parts[1])) ? Math.max(0, Math.round(Number(parts[1]))) : undefined,
				pciId: parts[2]!.slice(0, 64),
			}));
		if (gpus.length > 0) return gpus.slice(0, 16);
	}
	try {
		const entries = await fs.readdir('/dev/dri');
		const renders = entries.filter((entry) => entry.startsWith('renderD')).sort();
		return renders.slice(0, 16).map((entry) => ({ name: `DRM ${entry}` }));
	} catch {
		return [];
	}
}

/** Block devices and the two facts placement needs: rotational and transport. */
export async function diskFacts(): Promise<NonNullable<NodeHardware['disks']>> {
	const disks: NonNullable<NodeHardware['disks']> = [];
	let entries: string[];
	try {
		entries = await fs.readdir('/sys/block');
	} catch {
		return disks;
	}
	for (const name of entries.sort()) {
		if (!/^(sd|nvme|vd|xvd|hd)/.test(name)) continue;
		const base = `/sys/block/${name}`;
		const rotational = await readText(`${base}/queue/rotational`);
		const sectors = await readText(`${base}/size`);
		const transport = name.startsWith('nvme')
			? 'nvme'
			: name.startsWith('vd')
				? 'virtio'
				: name.startsWith('xvd')
					? 'virtio'
					: 'unknown';
		const disk: NonNullable<NodeHardware['disks']>[number] = { name, transport };
		if (rotational === '0' || rotational === '1') disk.rotational = rotational === '1';
		const sectorCount = Number(sectors);
		if (Number.isFinite(sectorCount) && sectorCount > 0) disk.sizeBytes = sectorCount * 512;
		disks.push(disk);
		if (disks.length >= 64) break;
	}
	return disks;
}

/** Physical NICs with speed and MTU; loopback and virtual interfaces stay out. */
export async function nicFacts(): Promise<NonNullable<NodeHardware['nics']>> {
	const nics: NonNullable<NodeHardware['nics']> = [];
	let entries: string[];
	try {
		entries = await fs.readdir('/sys/class/net');
	} catch {
		return nics;
	}
	for (const name of entries.sort()) {
		if (name === 'lo') continue;
		const base = `/sys/class/net/${name}`;
		const speed = Number(await readText(`${base}/speed`));
		const mtu = Number(await readText(`${base}/mtu`));
		const nic: NonNullable<NodeHardware['nics']>[number] = { name };
		if (Number.isFinite(speed) && speed > 0) nic.speedMbps = speed;
		if (Number.isFinite(mtu) && mtu > 0) nic.mtu = mtu;
		nics.push(nic);
		if (nics.length >= 32) break;
	}
	return nics;
}

async function osName(): Promise<string | undefined> {
	try {
		const text = await fs.readFile('/etc/os-release', 'utf8');
		const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text);
		return match?.[1]?.slice(0, 160);
	} catch {
		return undefined;
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return (await fs.readFile(path, 'utf8')).trim();
	} catch {
		return null;
	}
}

async function command(argv: string[]): Promise<string | null> {
	try {
		const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
		const output = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? output.trim() : null;
	} catch {
		return null;
	}
}
