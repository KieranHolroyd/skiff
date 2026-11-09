import { describe, expect, test } from 'bun:test';
import {
	defaultExportFileName,
	exportFormatFor,
	exportSummary,
	renderExport,
	toYaml,
	type ConfigExportDocument,
} from './config-export.ts';

const doc: ConfigExportDocument = {
	apiVersion: 'yoal.export/v1',
	exportedAt: '2026-11-09T10:00:00.000Z',
	platform: { url: 'https://control.example.com', contentDomain: 'example.dev', version: '1.2.3' },
	org: { id: 'org_1', name: 'Acme', slug: 'acme' },
	projectFilter: null,
	projects: [
		{
			slug: 'shop-api',
			workload: { command: ['bun', 'run', 'start'], port: 3000, env: { LOG_LEVEL: 'info', 'MIXED: key': 'a # b' }, secrets: [] },
			environments: [{ slug: 'production', access: 'public' }],
			attachments: { databases: [], storage: [] },
			placementSpec: null,
		},
	],
	secrets: [{ name: 'STRIPE_KEY' }],
	iam: { roles: [], bindings: [{ role: 'owner', yes: true }] },
	skipped: [{ section: 'pipelines', code: 'feature_disabled', reason: 'off' }],
};

describe('toYaml', () => {
	test('round-trips JSON data through a YAML parser', () => {
		const tricky = {
			strings: ['true', 'no', 'null', '~', '3000', '0x1f', '', ' padded ', 'line\nbreak', 'quote "x"', "it's", '- dash', '#hash', 'a: b', '@scope/pkg', 'plain-value'],
			numbers: [0, -1, 1.5, 1e21],
			booleans: [true, false],
			nothing: null,
			nested: [[1, [2]], [], {}, { a: { b: [{ c: 1, d: [] }] } }],
			'key with spaces': 1,
			'1numeric': 'x',
			skipped: undefined,
		};
		const parsed = Bun.YAML.parse(toYaml(tricky));
		expect(parsed).toEqual(JSON.parse(JSON.stringify(tricky)));
	});

	test('renders the whole export as YAML a parser reads back', () => {
		const text = renderExport(doc, 'yaml');
		expect(text.startsWith('# Yoal config export')).toBe(true);
		expect(Bun.YAML.parse(text)).toEqual(JSON.parse(JSON.stringify(doc)));
	});
});

describe('export helpers', () => {
	test('names the file after the org slug and date', () => {
		expect(defaultExportFileName(doc, 'yaml')).toBe('yoal-config-acme-2026-11-09.yaml');
		expect(defaultExportFileName({ ...doc, org: { id: 'org_1', name: null, slug: null } }, 'json')).toBe(
			'yoal-config-control.example.com-2026-11-09.json',
		);
	});

	test('picks the format from --format, then the --out extension', () => {
		expect(exportFormatFor(undefined, undefined)).toBe('yaml');
		expect(exportFormatFor(undefined, 'out.JSON')).toBe('json');
		expect(exportFormatFor('yml', 'out.json')).toBe('yaml');
		expect(() => exportFormatFor('toml', undefined)).toThrow(/yaml or json/);
	});

	test('summarises sections, not header fields', () => {
		expect(exportSummary(doc)).toEqual([
			{ section: 'projects', count: '1' },
			{ section: 'secrets', count: '1' },
			{ section: 'iam', count: 'yes' },
		]);
	});

	test('JSON output is the document as-is', () => {
		expect(JSON.parse(renderExport(doc, 'json'))).toEqual(doc);
	});
});
