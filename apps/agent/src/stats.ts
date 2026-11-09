import { promises as fs } from 'node:fs';
import type { Heartbeat } from '@yoal/contracts';

/** Node-level stats for heartbeats. Linux `/proc` is used when present; other hosts get a subset. */
export type HeartbeatStats = NonNullable<Heartbeat['stats']>;

interface CpuTimes {
	total: number;
	idle: number;
}

export class StatsCollector {
	private readonly dataDir: string;
	private previousCpu: CpuTimes | null = null;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
	}

	async collect(): Promise<HeartbeatStats> {
		const stats: HeartbeatStats = {};

		const cpu = await this.cpuPercent();
		if (cpu !== null) stats.cpuPercent = cpu;

		const memory = await memoryUsage();
		if (memory) {
			stats.memoryBytes = memory.used;
			stats.memoryTotalBytes = memory.total;
		}

		const disk = await diskUsage(this.dataDir);
		if (disk) {
			stats.diskUsedBytes = disk.used;
			stats.diskTotalBytes = disk.total;
			stats.diskFreeBytes = disk.free;
		}

		const uptime = await readFirstNumber('/proc/uptime');
		if (uptime !== null) stats.uptimeSeconds = uptime;

		const load1 = await readLoad1();
		if (load1 !== null) stats.load1 = load1;

		return stats;
	}

	private async cpuPercent(): Promise<number | null> {
		const current = await readCpuTimes();
		if (!current) return null;
		const previous = this.previousCpu;
		this.previousCpu = current;
		if (!previous) return 0;
		const totalDelta = current.total - previous.total;
		const idleDelta = current.idle - previous.idle;
		if (totalDelta <= 0) return 0;
		return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
	}
}

async function readCpuTimes(): Promise<CpuTimes | null> {
	try {
		const stat = await fs.readFile('/proc/stat', 'utf8');
		const line = stat.split('\n').find((row) => row.startsWith('cpu '));
		if (!line) return null;
		const fields = line
			.trim()
			.split(/\s+/)
			.slice(1)
			.map(Number)
			.filter((value) => Number.isFinite(value));
		if (fields.length < 5) return null;
		// user, nice, system, idle, iowait, irq, softirq, steal. Guest time is already included.
		const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
		const total = fields.reduce((sum, value) => sum + value, 0);
		return { total, idle };
	} catch {
		return null;
	}
}

async function memoryUsage(): Promise<{ used: number; total: number } | null> {
	try {
		const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
		const values = new Map<string, number>();
		for (const line of meminfo.split('\n')) {
			const match = /^([A-Za-z_()]+):\s+(\d+)/.exec(line);
			if (match?.[1] && match[2]) values.set(match[1], Number(match[2]) * 1024);
		}
		const total = values.get('MemTotal');
		const available = values.get('MemAvailable');
		if (!total || available === undefined) return null;
		return { total, used: Math.max(0, total - available) };
	} catch {
		return null;
	}
}

async function diskUsage(path: string): Promise<{ used: number; total: number; free: number } | null> {
	try {
		const stat = await fs.statfs(path);
		const blockSize = Number(stat.bsize);
		const total = Number(stat.blocks) * blockSize;
		const free = Number(stat.bfree) * blockSize;
		return { used: Math.max(0, total - free), total, free };
	} catch {
		return null;
	}
}

async function readLoad1(): Promise<number | null> {
	try {
		const loadavg = await fs.readFile('/proc/loadavg', 'utf8');
		const first = Number(loadavg.trim().split(/\s+/)[0]);
		return Number.isFinite(first) ? first : null;
	} catch {
		return null;
	}
}

async function readFirstNumber(path: string): Promise<number | null> {
	try {
		const text = await fs.readFile(path, 'utf8');
		const first = Number(text.trim().split(/\s+/)[0]);
		return Number.isFinite(first) ? first : null;
	} catch {
		return null;
	}
}
