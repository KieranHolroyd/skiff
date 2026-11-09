import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemdDriver, brokerFixedEnv, takeBrokerAuth, type CommandRunner, type RunResult } from './systemd.ts';
import { renderBrokerUnit, renderContainerUnit, renderNatsConfig } from './units.ts';
import { assertManagedId, parseWorkload, type WorkloadActivation, type WorkloadDesired } from './validate.ts';

/** The helper's fixed queue-broker profile (docs/BROKERS.md, D111). */

const MQ_ID = 'mq_0123456789abcdef0123456789abcdef';
const PASSWORD = 'Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4';
const directories: string[] = [];

class FakeRunner implements CommandRunner {
	calls: string[][] = [];
	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		if (argv[1] === 'show') return { code: 0, stdout: 'ActiveState=activating\nSubState=start\nNRestarts=0\n', stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: MQ_ID,
		projectId: MQ_ID,
		projectSlug: 'jobs',
		deploymentId: MQ_ID,
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
		...overrides,
	};
}

const broker = (overrides: Record<string, unknown> = {}): WorkloadDesired => parseWorkload(input(overrides));

function activation(env: Record<string, string> = {}): WorkloadActivation {
	return {
		workloadId: MQ_ID,
		activationVersion: 'b'.repeat(64),
		env: { YOAL_BROKER_USER: 'jobs', YOAL_BROKER_PASSWORD: PASSWORD, ...env },
		files: {},
	};
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('broker validation', () => {
	test('accepts NATS only with its own image, engine, version and id prefix', () => {
		expect(broker().broker).toEqual({ engine: 'nats', version: '2.12', storageMb: 2048 });
		expect(() => parseWorkload(input({ image: 'docker.io/library/nats:latest' }))).toThrow(/workload.image must be/);
		expect(() => parseWorkload(input({ broker: { engine: 'rabbitmq', version: '4.1', storageMb: 2048 } }))).toThrow(
			/engine must be one of nats/,
		);
		expect(() => parseWorkload(input({ broker: { engine: 'nats', version: '1.0', storageMb: 2048 } }))).toThrow(
			/version must be one of/,
		);
		expect(() => parseWorkload(input({ broker: { engine: 'nats', version: '2.12', storageMb: 2048, user: 'x' } }))).toThrow(
			/broker.user is not supported/,
		);
		expect(() => parseWorkload(input({ id: 'wld_abc' }))).toThrow(/must start with "mq_"/);
		expect(() => parseWorkload(input({ broker: undefined, image: 'docker.io/library/nats:2.12-alpine' }))).toThrow(
			/reserved for queue brokers/,
		);
	});

	test('a broker is never a worker, a process or a second managed profile', () => {
		expect(() => parseWorkload(input({ ingress: 'none' }))).toThrow(/cannot be workers/);
		expect(() => parseWorkload(input({ runtime: 'process', release: 'a'.repeat(64) }))).toThrow();
		expect(() =>
			parseWorkload(input({ database: { engine: 'postgres', version: '17' } })),
		).toThrow(/another managed profile/);
		expect(broker({ volumeId: 'vol_abc' }).volumeId).toBe('vol_abc');
	});

	test('purge accepts mq_ ids alongside db_ and st_', () => {
		expect(assertManagedId(MQ_ID)).toBe(MQ_ID);
		expect(() => assertManagedId('wld_abc')).toThrow(/"mq_"/);
	});
});

describe('broker unit and config', () => {
	test('the unit keeps the database lockdown and mounts the helper-written config', () => {
		const unit = renderContainerUnit({
			workload: broker(),
			image: 'ignored',
			envFile: '/run/env',
			dataDir: '/var/lib/yoal/mq',
			secretsDir: null,
			serverConfigPath: `/run/yoal-workloads/${MQ_ID}/broker.conf`,
		});
		expect(unit).toBe(
			renderBrokerUnit({
				workload: broker(),
				envFile: '/run/env',
				dataDir: '/var/lib/yoal/mq',
				serverConfigPath: `/run/yoal-workloads/${MQ_ID}/broker.conf`,
				apparmorProfile: null,
			}),
		);
		expect(unit).toContain('Image=docker.io/library/nats:2.12-alpine');
		expect(unit).toContain('Exec="nats-server" "--config" "/etc/yoal/broker.conf"');
		expect(unit).toContain('User=4222:4222');
		expect(unit).toContain('PublishPort=127.0.0.1:14222:4222');
		expect(unit).toContain('NetworkAlias=mq-0123456789abcdef0123456789abcdef');
		expect(unit).toContain(`Volume=/run/yoal-workloads/${MQ_ID}/broker.conf:/etc/yoal/broker.conf:ro,Z`);
		expect(unit).toContain('Volume=/var/lib/yoal/mq:/data:Z');
		for (const line of ['DropCapability=all', 'NoNewPrivileges=true', 'ReadOnly=true', 'MemoryMax=256M', 'CPUQuota=50%'])
			expect(unit).toContain(line);
		expect(() =>
			renderBrokerUnit({ workload: broker(), envFile: '/run/env', dataDir: '/x', serverConfigPath: null }),
		).toThrow(/server config/);
	});

	test('the NATS config has one user, JetStream in /data and both stores capped', () => {
		const config = renderNatsConfig({ id: MQ_ID, user: 'jobs', password: PASSWORD, memoryMb: 512, storageMb: 4096 });
		expect(config).toContain('server_name: "mq-0123456789abcdef0123456789abcdef"');
		expect(config).toContain('store_dir: "/data"');
		expect(config).toContain('max_memory_store: 128MB');
		expect(config).toContain('max_file_store: 4096MB');
		expect(config).toContain(`{ user: "jobs", password: "${PASSWORD}" }`);
		// Nothing on the wire can inject another directive.
		expect(() => renderNatsConfig({ id: MQ_ID, user: 'jobs"\n}', password: PASSWORD, memoryMb: 256, storageMb: 256 })).toThrow(
			/user name/,
		);
		expect(() => renderNatsConfig({ id: MQ_ID, user: 'jobs', password: 'short"', memoryMb: 256, storageMb: 256 })).toThrow(
			/base64url/,
		);
	});

	test('credentials leave the env; Go gets a soft memory limit', () => {
		const env: Record<string, string> = { YOAL_BROKER_USER: 'jobs', YOAL_BROKER_PASSWORD: PASSWORD, OTHER: '1' };
		expect(takeBrokerAuth(env)).toEqual({ user: 'jobs', password: PASSWORD });
		expect(env).toEqual({ OTHER: '1' });
		expect(() => takeBrokerAuth({})).toThrow(/user and password/);
		expect(brokerFixedEnv(256)).toEqual({ GOMEMLIMIT: '204MiB' });
	});
});

describe('broker apply', () => {
	async function fixture() {
		const root = await fs.mkdtemp(join(tmpdir(), 'yoal-helper-broker-'));
		directories.push(root);
		const runner = new FakeRunner();
		const chowns: Array<[string, number, number]> = [];
		const driver = new SystemdDriver({
			chown: async (path, uid, gid) => {
				chowns.push([path, uid, gid]);
			},
			runner,
			unitDir: join(root, 'units'),
			quadletDir: join(root, 'quadlet'),
			runtimeDir: join(root, 'run'),
			stateDir: join(root, 'state'),
			releaseDirs: [join(root, 'releases')],
			volumeRegistryFile: join(root, 'volumes.json'),
			bunPath: '/usr/local/bin/bun',
			socketMode: '0660',
			socketGroup: 'caddy',
		});
		return { root, runner, chowns, driver };
	}

	test('writes the config 0600 for the broker uid and keeps the password out of the env file', async () => {
		const f = await fixture();
		const status = await f.driver.apply(broker(), activation());
		expect(status.status).toBe('starting');

		const configPath = join(f.root, 'run', MQ_ID, 'broker.conf');
		expect(await fs.readFile(configPath, 'utf8')).toContain(`password: "${PASSWORD}"`);
		expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
		expect(f.chowns).toContainEqual([configPath, 4222, 4222]);
		expect(f.chowns).toContainEqual([join(f.root, 'state', MQ_ID), 4222, 4222]);

		const env = await fs.readFile(join(f.root, 'run', MQ_ID, 'env'), 'utf8');
		expect(env).toBe('GOMEMLIMIT=204MiB\n');
		expect(env).not.toContain(PASSWORD);

		const quadlet = await fs.readFile(join(f.root, 'quadlet', `yoal-workload-${MQ_ID}.container`), 'utf8');
		expect(quadlet).toContain('Exec="nats-server" "--config" "/etc/yoal/broker.conf"');
		// The first start pulls the image, so the restart is queued like any managed service.
		expect(f.runner.calls).toContainEqual(['/usr/bin/systemctl', 'restart', '--no-block', `yoal-workload-${MQ_ID}.service`]);
	});

	test('refuses an activation without the broker credentials before writing a unit', async () => {
		const f = await fixture();
		await expect(f.driver.apply(broker(), { ...activation(), env: {} })).rejects.toThrow(/user and password/);
		await expect(fs.stat(join(f.root, 'quadlet', `yoal-workload-${MQ_ID}.container`))).rejects.toThrow();
	});

	test('purge removes the unit and only <stateDir>/<mq id>', async () => {
		const f = await fixture();
		await f.driver.apply(broker(), activation());
		await fs.mkdir(join(f.root, 'state', MQ_ID, 'jetstream'), { recursive: true });
		await fs.mkdir(join(f.root, 'state', 'mq_other'), { recursive: true });
		await f.driver.purge(MQ_ID);
		await expect(fs.stat(join(f.root, 'state', MQ_ID))).rejects.toThrow();
		await fs.stat(join(f.root, 'state', 'mq_other'));
		await expect(fs.stat(join(f.root, 'quadlet', `yoal-workload-${MQ_ID}.container`))).rejects.toThrow();
	});
});
