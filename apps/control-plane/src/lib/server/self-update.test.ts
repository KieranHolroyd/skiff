import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'skiff-update-log-'));
const logFile = join(dir, 'update.log');
process.env.SKIFF_UPDATE_LOG_FILE = logFile;
// `version.ts` reads the build-time constant at module load.
(globalThis as { __SKIFF_VERSION__?: string }).__SKIFF_VERSION__ = '0.0.0';
const { parseUpdateLog, readUpdateLog } = await import('./self-update.js');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const record = (text: string, level = 'info', at = '2026-01-01T00:00:00.000Z') =>
	JSON.stringify({ at, level, text });

describe('parseUpdateLog', () => {
	test('keeps valid records in order and normalises unknown levels', () => {
		const parsed = parseUpdateLog(
			[
				record('[building] Build', 'phase'),
				'not json at all',
				record('hello', 'chatty'),
				record('careful', 'warn')
			].join('\n')
		);
		expect(parsed.truncated).toBe(false);
		expect(parsed.lines.map((line) => [line.level, line.text])).toEqual([
			['phase', '[building] Build'],
			['info', 'hello'],
			['warn', 'careful']
		]);
	});

	test('drops malformed records and caps the line count', () => {
		const text = Array.from({ length: 10 }, (_, index) => record(`line ${index}`)).join('\n');
		const parsed = parseUpdateLog(text, 3);
		expect(parsed.truncated).toBe(true);
		expect(parsed.lines.map((line) => line.text)).toEqual(['line 7', 'line 8', 'line 9']);
	});
});

describe('readUpdateLog', () => {
	test('reports a missing log without throwing', () => {
		expect(readUpdateLog()).toEqual({
			lines: [],
			exists: false,
			truncated: false,
			updatedAt: null
		});
	});

	test('returns the newest lines from disk', () => {
		writeFileSync(
			logFile,
			`${Array.from({ length: 5 }, (_, index) => record(`line ${index}`)).join('\n')}\n`
		);
		const log = readUpdateLog(3);
		expect(log.exists).toBe(true);
		expect(log.truncated).toBe(true);
		expect(log.lines.map((line) => line.text)).toEqual(['line 2', 'line 3', 'line 4']);
		expect(log.updatedAt).not.toBeNull();
	});
});
