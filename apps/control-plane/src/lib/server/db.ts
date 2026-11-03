import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dataDir } from './config';

mkdirSync(dataDir, { recursive: true });

/** Platform state (DESIGN §8: SQLite is the source of truth; DuckDB is telemetry only). */
export const db = new Database(`${dataDir}/skiff.db`, { create: true, strict: true });
for (const pragma of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000'])
	db.run(`PRAGMA ${pragma}`);
