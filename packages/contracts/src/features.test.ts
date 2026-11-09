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
			'BROKERS',
			'EMAIL',
			'BACKUPS_RESTORE',
			'PITR',
			'OBJECT_BROWSER',
			'POOLER',
			'DB_STUDIO',
			'COMPOSE',
			'CONTAINER_CONSOLE',
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
			'MEDIA',
			'DB_AUTO_PROMOTE'
		]);
		for (const name of FEATURE_FLAG_NAMES) {
			expect(FEATURE_FLAGS[name].name).toBe(name);
			expect(FEATURE_FLAGS[name].description.length).toBeGreaterThan(10);
			expect(FEATURE_FLAGS[name].area).toBeTruthy();
			expect(DEFAULT_FEATURES[name]).toBe(FEATURE_FLAGS[name].default);
		}
	});

	test('every flag defaults on (each is a kill switch)', () => {
		for (const name of FEATURE_FLAG_NAMES) expect(DEFAULT_FEATURES[name]).toBe(true);
	});

	test('uses YOAL_FEATURE_<NAME> as the env key', () => {
		expect(featureEnvKey('BACKUPS_RESTORE')).toBe('YOAL_FEATURE_BACKUPS_RESTORE');
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
		const env = Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [featureEnvKey(name), 'off']));
		const flags = parseFeatureFlags(env);
		for (const name of FEATURE_FLAG_NAMES) expect(flags[name]).toBe(false);
	});

	test('accepts explicit false without changing other defaults', () => {
		expect(parseFeatureFlags({ YOAL_FEATURE_QUOTAS: 'off' }).QUOTAS).toBe(false);
		expect(parseFeatureFlags({ YOAL_FEATURE_BACKUPS_RESTORE: '0' }).BACKUPS_RESTORE).toBe(false);
		expect(parseFeatureFlags({ YOAL_FEATURE_BACKUPS_RESTORE: '0' }).QUOTAS).toBe(true);
	});

	test('malformed values keep the safe default', () => {
		const flags = parseFeatureFlags({
			YOAL_FEATURE_PITR: 'enabled',
			YOAL_FEATURE_QUOTAS: 'disabled'
		});
		expect(flags.PITR).toBe(true);
		expect(flags.QUOTAS).toBe(true);
	});

	test('ignores unknown YOAL_FEATURE_* variables', () => {
		const flags = parseFeatureFlags({
			YOAL_FEATURE_NOT_REGISTERED: '1'
		} as Record<string, string>);
		expect(flags).toEqual(DEFAULT_FEATURES);
		expect('NOT_REGISTERED' in flags).toBe(false);
	});

	test('a retired flag (DB_CONSOLE) is ignored, never an error', () => {
		const flags = parseFeatureFlags({ YOAL_FEATURE_DB_CONSOLE: '1' });
		expect(flags).toEqual(DEFAULT_FEATURES);
		expect('DB_CONSOLE' in flags).toBe(false);
	});
});

describe('retiredFeatureFlagsSet', () => {
	test('reports retired flags that are still set so startup can warn', () => {
		expect(retiredFeatureFlagsSet({})).toEqual([]);
		const set = retiredFeatureFlagsSet({ YOAL_FEATURE_DB_CONSOLE: '0' });
		expect(set.map((flag) => flag.env)).toEqual(['YOAL_FEATURE_DB_CONSOLE']);
		expect(set[0]?.reason).toContain('DB_STUDIO');
	});
});
