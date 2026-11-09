import { describe, expect, test } from 'bun:test';
import {
	buildEnvSuggestions,
	databasePrefixFromEnvName,
	databasePrefixesFromEnvNames,
	detectEnvNames,
	formatEnvFile,
	isEnvFileName,
	nextEnvPrefix,
	parseEnvFile,
	parseEnvFileNames,
	storagePrefixFromEnvName,
	storagePrefixesFromEnvNames
} from './env.ts';

describe('detectEnvNames', () => {
	test('finds the common access patterns across languages', () => {
		const source = `
			process.env.DATABASE_URL
			Bun.env["LOG_LEVEL"]
			import.meta.env.VITE_API_URL
			Deno.env.get('DENO_TOKEN')
			os.environ.get('PYTHON_TOKEN')
			os.environ['DJANGO_SECRET']
			os.getenv("GO_TOKEN")
			Environment.GetEnvironmentVariable("DOTNET_TOKEN")
			ENV['RUBY_TOKEN']
			env('LARAVEL_TOKEN')
		`;
		expect(detectEnvNames(source)).toEqual([
			'DATABASE_URL',
			'LOG_LEVEL',
			'VITE_API_URL',
			'DENO_TOKEN',
			'PYTHON_TOKEN',
			'DJANGO_SECRET',
			'GO_TOKEN',
			'DOTNET_TOKEN',
			'RUBY_TOKEN',
			'LARAVEL_TOKEN'
		]);
	});

	test('ignores dynamic access, lower-case names and operating-system noise', () => {
		const source = `
			process.env[key]
			process.env.databaseUrl
			process.env.PATH
			process.env.HOME
			process.env.REAL_VALUE
		`;
		expect(detectEnvNames(source)).toEqual(['REAL_VALUE']);
	});

	test('dedupes and respects the limit', () => {
		const source = 'process.env.A process.env.A process.env.B process.env.C';
		expect(detectEnvNames(source, 2)).toEqual(['A', 'B']);
	});
});

describe('env files', () => {
	test('recognises the Railway-style file names', () => {
		expect(isEnvFileName('.env')).toBe(true);
		expect(isEnvFileName('.env.example')).toBe(true);
		expect(isEnvFileName('.env.production.local')).toBe(true);
		expect(isEnvFileName('nested/.env')).toBe(true);
		expect(isEnvFileName('env.example')).toBe(true);
		expect(isEnvFileName('src/env.ts')).toBe(false);
		expect(isEnvFileName('environment.txt')).toBe(false);
	});

	test('parses keys without returning values', () => {
		const text = `
			# comment
			DATABASE_URL=postgres://user:pass@host/db
			export API_KEY="secret"
			ignored line
			EMPTY=
			DATABASE_URL=second
		`;
		expect(parseEnvFileNames(text)).toEqual(['DATABASE_URL', 'API_KEY', 'EMPTY']);
	});
});

describe('buildEnvSuggestions', () => {
	test('puts injected names first and never suggests a shadowing duplicate', () => {
		const suggestions = buildEnvSuggestions({
			databases: [{ name: 'main', envNames: ['DATABASE_URL', 'DATABASE_HOST'] }],
			storage: [{ name: 'media', envNames: ['S3_ENDPOINT_URL'] }],
			secretNames: ['STRIPE_SECRET_KEY'],
			detected: [
				{ name: 'DATABASE_URL', source: 'env-file', detail: '.env.example' },
				{ name: 'DATABASE_URL', source: 'code', detail: 'src/db.ts' },
				{ name: 'PUBLIC_URL', source: 'code', detail: 'src/app.ts' }
			],
			includeCommon: false
		});

		expect(suggestions.map((item) => item.name)).toEqual([
			'DATABASE_URL',
			'DATABASE_HOST',
			'S3_ENDPOINT_URL',
			'STRIPE_SECRET_KEY',
			'PUBLIC_URL'
		]);
		expect(suggestions[0]).toMatchObject({
			source: 'database',
			detail: 'main',
			injected: true
		});
		expect(suggestions[4]).toMatchObject({
			source: 'code',
			detail: 'src/app.ts',
			injected: false
		});
	});

	test('includes the curated common names unless disabled', () => {
		expect(buildEnvSuggestions({}).some((item) => item.name === 'NODE_ENV')).toBe(true);
		expect(buildEnvSuggestions({ includeCommon: false })).toEqual([]);
	});
});

describe('attachment prefixes', () => {
	test('infers a database prefix from connection variable names', () => {
		expect(databasePrefixFromEnvName('DATABASE_URL')).toBe('DATABASE');
		expect(databasePrefixFromEnvName('POSTGRES_PASSWORD')).toBe('POSTGRES');
		expect(databasePrefixFromEnvName('S3_ENDPOINT_URL')).toBeNull();
	});

	test('infers a storage prefix from S3/AWS variable names', () => {
		expect(storagePrefixFromEnvName('S3_ENDPOINT_URL')).toBe('S3');
		expect(storagePrefixFromEnvName('S3_PUBLIC_ENDPOINT_URL')).toBe('S3');
		expect(storagePrefixFromEnvName('AWS_ACCESS_KEY_ID')).toBe('AWS');
		expect(storagePrefixFromEnvName('DATABASE_URL')).toBeNull();
	});

	test('picks the first free prefix', () => {
		expect(nextEnvPrefix('DATABASE', [])).toBe('DATABASE');
		expect(nextEnvPrefix('DATABASE', ['DATABASE'])).toBe('DATABASE_2');
		expect(nextEnvPrefix('DATABASE', ['DATABASE', 'DATABASE_2'])).toBe('DATABASE_3');
	});

	test('does not mistake a generic URL for a database', () => {
		expect(databasePrefixesFromEnvNames(['APP_URL', 'CORS_ORIGIN'])).toEqual([]);
		expect(databasePrefixesFromEnvNames(['DATABASE_URL'])).toEqual(['DATABASE']);
		expect(databasePrefixesFromEnvNames(['POSTGRES_URL', 'POSTGRES_HOST'])).toEqual(['POSTGRES']);
		expect(databasePrefixesFromEnvNames(['SHOP_URL', 'SHOP_HOST'])).toEqual(['SHOP']);
	});

	test('groups storage names and ignores a lone generic suffix', () => {
		expect(storagePrefixesFromEnvNames(['S3_BUCKET'])).toEqual(['S3']);
		expect(storagePrefixesFromEnvNames(['AWS_REGION'])).toEqual(['AWS']);
		expect(storagePrefixesFromEnvNames(['APP_REGION'])).toEqual([]);
		expect(storagePrefixesFromEnvNames(['MEDIA_ENDPOINT_URL', 'MEDIA_BUCKET'])).toEqual(['MEDIA']);
	});
});

describe('parseEnvFile', () => {
	test('reads values with dotenv quoting rules', () => {
		const text = [
			'# comment',
			'',
			'export PORT=3000',
			'NAME = yoal ',
			'URL=https://example.com/#anchor # trailing comment',
			"SINGLE='keep $HOME \\n literal'",
			'DOUBLE="line one\\nline \\"two\\""',
			'EMPTY=',
			'MULTI="first',
			'second"',
			'not a variable',
			'PORT=4000'
		].join('\n');
		const parsed = parseEnvFile(text);
		expect(parsed.entries).toEqual([
			{ key: 'NAME', value: 'yoal' },
			{ key: 'URL', value: 'https://example.com/#anchor' },
			{ key: 'SINGLE', value: 'keep $HOME \\n literal' },
			{ key: 'DOUBLE', value: 'line one\nline "two"' },
			{ key: 'EMPTY', value: '' },
			{ key: 'MULTI', value: 'first\nsecond' },
			{ key: 'PORT', value: '4000' }
		]);
		expect(parsed.invalidLines).toEqual([11]);
	});

	test('reports an unterminated quote and keeps going', () => {
		expect(parseEnvFile('A="open\nB=2')).toEqual({ entries: [], invalidLines: [1] });
		expect(parseEnvFile('﻿A=1\r\nB=2\r\n').entries).toEqual([
			{ key: 'A', value: '1' },
			{ key: 'B', value: '2' }
		]);
	});

	test('formatEnvFile round-trips through parseEnvFile', () => {
		const entries = [
			{ key: 'PLAIN', value: 'postgres://u@h:5432/db' },
			{ key: 'SPACES', value: 'hello world' },
			{ key: 'TRICKY', value: 'a "quote" \\ back\nslash # hash\ttab' },
			{ key: 'EMPTY', value: '' }
		];
		const text = formatEnvFile(entries);
		expect(text.startsWith('PLAIN=postgres://u@h:5432/db\nSPACES="hello world"\n')).toBe(true);
		expect(parseEnvFile(text)).toEqual({ entries, invalidLines: [] });
		expect(formatEnvFile([])).toBe('');
	});
});
