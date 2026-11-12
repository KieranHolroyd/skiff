#!/usr/bin/env bun
/**
 * Check that a harness run actually produced the expected captures.
 *
 * The runner calls this after the sink run. It answers "did each SDK send its five error events
 * and at least one telemetry item?" rather than trusting a zero exit code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [capturesDir, runId, repeatRaw = '1', only = ''] = process.argv.slice(2);
if (!capturesDir || !runId) {
	console.error('usage: bun run verify.ts <captures-dir> <run-id> [repeat] [only]');
	process.exit(2);
}
const repeat = Number(repeatRaw);
if (!Number.isInteger(repeat) || repeat < 1) {
	console.error('repeat must be a positive integer');
	process.exit(2);
}

const manifestPath = join(capturesDir, 'manifest.jsonl');
if (!existsSync(manifestPath)) {
	console.error(`missing ${manifestPath}`);
	process.exit(1);
}

type Entry = { file: string; project: string; endpoint: string; eventId: string | null; items: string[] };

const entries: Entry[] = readFileSync(manifestPath, 'utf8')
	.split('\n')
	.filter(Boolean)
	.flatMap((line) => {
		try {
			const entry = JSON.parse(line) as Entry;
			return typeof entry.file === 'string' && entry.file.startsWith(`${runId}-`) ? [entry] : [];
		} catch {
			return [];
		}
	});

const projects = [
	{ lang: 'js', id: '1' },
	{ lang: 'php', id: '2' },
	{ lang: 'go', id: '3' },
];
const selected = only ? projects.filter((project) => project.lang === only) : projects;
if (selected.length === 0) {
	console.error(`unknown --only ${only}`);
	process.exit(2);
}

let failed = false;

for (const project of selected) {
	const mine = entries.filter((entry) => entry.project === project.id);
	const events = mine.filter((entry) => entry.items.includes('event'));
	const telemetry = mine.filter((entry) => entry.items.some((item) => item !== 'event'));
	const badIds = events.filter((entry) => !entry.eventId || !/^[0-9a-f]{32}$/.test(entry.eventId));
	const missingFiles = mine.filter((entry) => !existsSync(join(capturesDir, entry.file)));

	const okEvents = events.length >= 5 * repeat;
	const okTelemetry = telemetry.length >= repeat;
	const okIds = badIds.length === 0;
	const okFiles = missingFiles.length === 0;

	if (okEvents && okTelemetry && okIds && okFiles) {
		console.log(
			`verify: ${project.lang.padEnd(3)} project ${project.id}: ${events.length} event(s), ${telemetry.length} telemetry item(s), ok`,
		);
		continue;
	}

	failed = true;
	console.error(`verify: ${project.lang} project ${project.id}: FAILED`);
	if (!okEvents) console.error(`  expected at least ${5 * repeat} event envelopes, got ${events.length}`);
	if (!okTelemetry) console.error(`  expected at least ${repeat} telemetry envelope(s), got ${telemetry.length}`);
	if (!okIds) console.error(`  invalid event ids: ${badIds.map((entry) => entry.file).join(', ')}`);
	if (!okFiles) console.error(`  missing capture files: ${missingFiles.map((entry) => entry.file).join(', ')}`);
}

if (failed) process.exit(1);
console.log(`verify: ok (${entries.length} capture(s) from run ${runId})`);
