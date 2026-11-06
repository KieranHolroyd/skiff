import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_FEATURES,
	FEATURE_FLAGS,
	FEATURE_FLAG_NAMES,
	featureEnvKey,
	parseFeatureFlagValue,
	parseFeatureFlags,
	retiredFeatureFlagsSet
} from './features.ts';

describe('feature registry', () => {
	test('registers every known flag with a description and area', () => {
		expect(FEATURE_FLAG_NAMES).toEqual([
			'FUNCTIONS',
			'BACKUPS_RESTORE',
			'PITR',
			'OBJECT_BROWSER',
			'POOLER',
			'DB_STUDIO',
			'DB_TLS',
			'ORG_NETWORKS',
			'MULTI_NODE_REPLICAS',
			'SERVICE_ENDPOINTS',
			'APP_VOLUMES',
			'JOBS',
			'PREVIEW_DATA',
			'AGENT_DATA_WRITE',
			'QUOTAS',
			'UPGRADE_ROLLBACK',
			'BLUEPRINTS',
			'MEDIA'
		]);
		for (const name of FEATURE_FLAG_NAMES) {
			expect(FEATURE_FLAGS[name].name).toBe(name);
			expect(FEATURE_FLAGS[name].description.length).toBeGreaterThan(10);
			expect(FEATURE_FLAGS[name].area).toBeTruthy();
			expect(DEFAULT_FEATURES[name]).toBe(FEATURE_FLAGS[name].default);
		}
	});

	test('shipped surfaces default on', () => {
		// These are live features; unset must preserve existing behaviour.
		expect(DEFAULT_FEATURES.BACKUPS_RESTORE).toBe(true);
		expect(DEFAULT_FEATURES.OBJECT_BROWSER).toBe(true);
		expect(DEFAULT_FEATURES.POOLER).toBe(true);
		expect(DEFAULT_FEATURES.DB_STUDIO).toBe(true);
		expect(DEFAULT_FEATURES.QUOTAS).toBe(true);
	});

	test('unshipped risky features default off', () => {
		for (const name of [
			'PITR',
			'DB_TLS',
			'ORG_NETWORKS',
			'MULTI_NODE_REPLICAS',
			'SERVICE_ENDPOINTS',
			'APP_VOLUMES',
			'JOBS',
			'PREVIEW_DATA',
			'AGENT_DATA_WRITE',
			'UPGRADE_ROLLBACK',
			'BLUEPRINTS',
			'MEDIA'
		] as const) {
			expect(DEFAULT_FEATURES[name]).toBe(false);
		}
	});

	test('uses SKIFF_FEATURE_<NAME> as the env key', () => {
		expect(featureEnvKey('BACKUPS_RESTORE')).toBe('SKIFF_FEATURE_BACKUPS_RESTORE');
	});
});

describe('parseFeatureFlagValue', () => {
	test('accepts the documented truthy and falsy spellings', () => {
		for (const value of ['1', 'true', 'TRUE', 'On', 'yes', ' yes '])
			expect(parseFeatureFlagValue(value)).toBe(true);
		for (const value of ['0', 'false', 'FALSE', 'Off', 'no', ' no '])
			expect(parseFeatureFlagValue(value)).toBe(false);
	});

	test('returns undefined for unset or malformed values', () => {
		expect(parseFeatureFlagValue(undefined)).toBeUndefined();
		expect(parseFeatureFlagValue('')).toBeUndefined();
		expect(parseFeatureFlagValue('maybe')).toBeUndefined();
		expect(parseFeatureFlagValue('2')).toBeUndefined();
		expect(parseFeatureFlagValue('enabled')).toBeUndefined();
	});
});

describe('parseFeatureFlags', () => {
	test('preserves registry defaults when nothing is set', () => {
		expect(parseFeatureFlags({})).toEqual(DEFAULT_FEATURES);
	});

	test('reads each registered flag', () => {
		const flags = parseFeatureFlags({
			SKIFF_FEATURE_BACKUPS_RESTORE: 'on',
			SKIFF_FEATURE_PITR: '1',
			SKIFF_FEATURE_OBJECT_BROWSER: 'yes',
			SKIFF_FEATURE_POOLER: 'true',
			SKIFF_FEATURE_DB_TLS: 'TRUE',
			SKIFF_FEATURE_ORG_NETWORKS: 'on',
			SKIFF_FEATURE_APP_VOLUMES: '1',
			SKIFF_FEATURE_JOBS: 'yes',
			SKIFF_FEATURE_PREVIEW_DATA: 'true',
			SKIFF_FEATURE_AGENT_DATA_WRITE: 'on',
			SKIFF_FEATURE_BLUEPRINTS: '1',
			SKIFF_FEATURE_MEDIA: 'yes'
		});
		expect(flags).toMatchObject({
			BACKUPS_RESTORE: true,
			PITR: true,
			OBJECT_BROWSER: true,
			POOLER: true,
			DB_TLS: true,
			ORG_NETWORKS: true,
			APP_VOLUMES: true,
			JOBS: true,
			PREVIEW_DATA: true,
			AGENT_DATA_WRITE: true,
			BLUEPRINTS: true,
			MEDIA: true,
			QUOTAS: true
		});
	});

	test('accepts explicit false without changing other defaults', () => {
		expect(parseFeatureFlags({ SKIFF_FEATURE_QUOTAS: 'off' }).QUOTAS).toBe(false);
		expect(parseFeatureFlags({ SKIFF_FEATURE_BACKUPS_RESTORE: '0' }).BACKUPS_RESTORE).toBe(false);
		expect(parseFeatureFlags({ SKIFF_FEATURE_BACKUPS_RESTORE: '0' }).QUOTAS).toBe(true);
	});

	test('malformed values keep the safe default', () => {
		const flags = parseFeatureFlags({
			SKIFF_FEATURE_PITR: 'enabled',
			SKIFF_FEATURE_QUOTAS: 'disabled'
		});
		expect(flags.PITR).toBe(false);
		expect(flags.QUOTAS).toBe(true);
	});

	test('ignores unknown SKIFF_FEATURE_* variables', () => {
		const flags = parseFeatureFlags({
			SKIFF_FEATURE_NOT_REGISTERED: '1'
		} as Record<string, string>);
		expect(flags).toEqual(DEFAULT_FEATURES);
		expect('NOT_REGISTERED' in flags).toBe(false);
	});

	test('a retired flag (DB_CONSOLE) is ignored, never an error', () => {
		const flags = parseFeatureFlags({ SKIFF_FEATURE_DB_CONSOLE: '1' });
		expect(flags).toEqual(DEFAULT_FEATURES);
		expect('DB_CONSOLE' in flags).toBe(false);
	});
});

describe('retiredFeatureFlagsSet', () => {
	test('reports retired flags that are still set so startup can warn', () => {
		expect(retiredFeatureFlagsSet({})).toEqual([]);
		const set = retiredFeatureFlagsSet({ SKIFF_FEATURE_DB_CONSOLE: '0' });
		expect(set.map((flag) => flag.env)).toEqual(['SKIFF_FEATURE_DB_CONSOLE']);
		expect(set[0]?.reason).toContain('DB_STUDIO');
	});
});
