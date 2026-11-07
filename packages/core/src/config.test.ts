import { describe, expect, test } from 'bun:test';
import { STUDIO_DEFAULT_PORT } from '@skiff/contracts';
import { coreConfigFromEnv } from './config.ts';
import type { ObjectStore } from './object-store.ts';

const base = {
	dataDir: '/tmp/skiff-config-test',
	objectStore: {} as ObjectStore,
	masterKey: new Uint8Array(32),
};

describe('coreConfigFromEnv', () => {
	test('reads the documented SKIFF_* variables (docs/OPS.md §2.1, §2.5.1)', () => {
		const config = coreConfigFromEnv(base, {
			SKIFF_DATABASE_GATEWAY_PORT: '9182',
			SKIFF_STUDIO_PORT: '9183',
			SKIFF_STORAGE_OBJECT_MAX_BYTES: '2048',
			SKIFF_STORAGE_GATEWAY_PORT: '9181',
			SKIFF_PITR_REPO_BUCKET: 'pitr',
			SKIFF_PITR_ACCESS_KEY_ID: 'AKIA',
			SKIFF_PITR_SECRET_ACCESS_KEY: 'secret',
			SKIFF_PITR_REPO_ENDPOINT: 'https://s3.example.com',
			SKIFF_PITR_REPO_FORCE_PATH_STYLE: 'off',
		});
		expect(config.databaseGatewayPort).toBe(9182);
		expect(config.studioPort).toBe(9183);
		expect(config.storageObjectMaxBytes).toBe(2048);
		expect(config.storageGatewayPort).toBe(9181);
		expect(config.pitrRepository).toEqual({
			kind: 's3',
			endpoint: 'https://s3.example.com',
			bucket: 'pitr',
			region: 'us-east-1',
			pathPrefix: 'skiff/pitr',
			forcePathStyle: false,
			accessKeyId: 'AKIA',
			secretAccessKey: 'secret',
		});
	});

	test('falls back to defaults for unset or malformed values', () => {
		const config = coreConfigFromEnv(base, {
			SKIFF_DATABASE_GATEWAY_PORT: 'eighty',
			SKIFF_STORAGE_OBJECT_MAX_BYTES: '-1',
			SKIFF_EDGE_NODE_ID: '',
			SKIFF_PITR_REPO_BUCKET: 'pitr',
		});
		expect(config.databaseGatewayPort).toBe(8082);
		expect(config.studioPort).toBe(STUDIO_DEFAULT_PORT);
		expect(config.storageObjectMaxBytes).toBe(104_857_600);
		expect(config.storageGatewayPort).toBe(8081);
		// The installer writes an empty edge id before enrolment; that is "unset", not a node id.
		expect(config.edgeNodeId).toBeUndefined();
		// An incomplete PITR repository fails closed.
		expect(config.pitrRepository).toBeUndefined();
	});

	test('explicit values win over the environment', () => {
		const config = coreConfigFromEnv(
			{ ...base, studioPort: 7000, edgeNodeId: 'nod_edge', desiredAgentVersion: '2.0.0' },
			{ SKIFF_STUDIO_PORT: '9183', SKIFF_EDGE_NODE_ID: 'nod_other', SKIFF_AGENT_VERSION: '1.0.0' },
		);
		expect(config.studioPort).toBe(7000);
		expect(config.edgeNodeId).toBe('nod_edge');
		expect(config.desiredAgentVersion).toBe('2.0.0');
	});
});
