import { describe, expect, test } from 'bun:test';
import type { WorkloadDesired } from '@yoal/contracts';
import { brokerProbeHandshake, probeDatabasePort, probeWorkloadHealth, withOptionalSpec, workloadFingerprint } from './runtime.ts';

/** Queue brokers on the agent side (docs/BROKERS.md, D111). */

function listen(greeting: string | null) {
	return Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(socket) {
				if (greeting !== null) socket.write(greeting);
			},
			data() {},
		},
	});
}

const broker: WorkloadDesired = {
	id: 'mq_abc',
	projectId: 'mq_abc',
	projectSlug: 'jobs',
	deploymentId: 'mq_abc',
	runtime: 'container',
	status: 'running',
	release: null,
	image: 'docker.io/library/nats:2.12-alpine',
	upstream: '127.0.0.1:14222',
	memoryMb: 256,
	cpus: 0.5,
	port: 14222,
	healthPath: '/',
	socketActivation: false,
	activationVersion: 'b'.repeat(64),
	env: {},
	secrets: [],
	dataSizeMb: null,
	broker: { engine: 'nats', version: '2.12', storageMb: 2048 },
};

describe('broker health probe', () => {
	test('only a real NATS INFO greeting counts as up', async () => {
		const signal = new AbortController().signal;
		const nats = listen('INFO {"server_id":"x","version":"2.12.0"}\r\n');
		const silent = listen(null);
		const other = listen('+OK\r\n');
		try {
			const handshake = brokerProbeHandshake('nats');
			expect(await probeDatabasePort(nats.port, signal, { handshake, timeoutMs: 500 })).toBe(true);
			// Podman's forwarder accepts the connect but never speaks.
			expect(await probeDatabasePort(silent.port, signal, { handshake, timeoutMs: 150 })).toBe(false);
			expect(await probeDatabasePort(other.port, signal, { handshake, timeoutMs: 500 })).toBe(false);
			expect(await probeWorkloadHealth({ ...broker, port: nats.port }, '/run/x', signal)).toBe(true);
		} finally {
			nats.stop(true);
			silent.stop(true);
			other.stop(true);
		}
	});
});

describe('broker spec on the agent', () => {
	test('the profile reaches the helper and a store resize re-renders the unit', () => {
		expect(withOptionalSpec(broker).broker).toEqual({ engine: 'nats', version: '2.12', storageMb: 2048 });
		const resized = { ...broker, broker: { ...broker.broker!, storageMb: 4096 } };
		expect(workloadFingerprint(resized)).not.toBe(workloadFingerprint(broker));
		// Workloads without a broker keep their fingerprint shape.
		const { broker: _omit, ...app } = broker;
		expect(workloadFingerprint(app)).not.toContain('broker');
	});
});
