import { describe, expect, test } from 'bun:test';
import {
	DATABASE_STUDIO_READONLY_RESERVED_NAME,
	DATABASE_STUDIO_READONLY_USER,
	databaseStudioPrincipalActivationSchema,
	databaseStudioPrincipalTaskSchema,
} from './database-studio-principal.ts';
import { databaseCreateSchema, databaseEngineRegistry, databaseEngines, databaseIdentifier } from './database.ts';
import { desiredStateSchema, heartbeatSchema } from './agent.ts';

describe('read-only studio principal contract', () => {
	test('every engine reserves the database name whose owner would be the principal', () => {
		expect(databaseIdentifier(DATABASE_STUDIO_READONLY_RESERVED_NAME)).toBe(DATABASE_STUDIO_READONLY_USER);
		for (const engine of databaseEngines) {
			expect(databaseEngineRegistry[engine].reservedNames).toContain(DATABASE_STUDIO_READONLY_RESERVED_NAME);
			const parsed = databaseCreateSchema.safeParse({ name: DATABASE_STUDIO_READONLY_RESERVED_NAME, engine });
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.message).toMatch(/reserved/);
		}
	});

	test('the activation only carries the fixed user and a generated password', () => {
		const base = { databaseId: 'db_1', generation: 1, engine: 'postgres', database: 'app', password: 'A'.repeat(32) };
		expect(databaseStudioPrincipalActivationSchema.parse({ ...base, user: 'yoal_studio_ro' }).user).toBe('yoal_studio_ro');
		expect(databaseStudioPrincipalActivationSchema.safeParse({ ...base, user: 'app' }).success).toBe(false);
		expect(databaseStudioPrincipalActivationSchema.safeParse({ ...base, user: 'yoal_studio_ro', password: "x';--" }).success).toBe(false);
		expect(databaseStudioPrincipalActivationSchema.safeParse({ ...base, user: 'yoal_studio_ro', password: 'short' }).success).toBe(false);
	});

	test('desired state and heartbeat default and accept the new fields', () => {
		const state = desiredStateSchema.parse({
			version: 1,
			nodeId: 'node_1',
			agentVersion: '0.1.0',
			generatedAt: new Date(0).toISOString(),
			contentDomain: 'sites.test',
			releases: [],
			routes: [],
		});
		expect(state.databaseStudioPrincipals).toEqual([]);
		expect(databaseStudioPrincipalTaskSchema.safeParse({ databaseId: 'db_1', generation: 0 }).success).toBe(false);
		const beat = heartbeatSchema.parse({
			nodeId: 'node_1',
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			databaseStudioPrincipalResults: [{ databaseId: 'db_1', generation: 2, status: 'failed', error: 'boom' }],
		});
		expect(beat.databaseStudioPrincipalResults).toEqual([{ databaseId: 'db_1', generation: 2, status: 'failed', error: 'boom' }]);
	});
});
