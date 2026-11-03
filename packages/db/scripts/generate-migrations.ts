#!/usr/bin/env bun
// Embed SQL migrations so the bundled control plane does not depend on a migrations directory.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'migrations');
const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
const body = files
	.map((file) => `\t{ id: ${JSON.stringify(file)}, sql: ${JSON.stringify(readFileSync(join(dir, file), 'utf8'))} },`)
	.join('\n');
writeFileSync(
	join(root, 'src', 'migrations.ts'),
	`// GENERATED from migrations/*.sql by scripts/generate-migrations.ts — do not edit by hand.\nexport const migrations: ReadonlyArray<{ id: string; sql: string }> = [\n${body}\n];\n`,
);
console.log(`embedded ${files.length} migration(s)`);
