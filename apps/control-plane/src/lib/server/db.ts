import { createDb } from '@yoal/db';
import { dataDir } from './config';

/**
 * One SQLite handle shared by Better Auth (raw) and Yoal's Drizzle schema. Yoal migrations run
 * here; Better Auth applies its own schema on boot in `hooks.server.ts` (TODO(release): replace
 * with forward-only migrations run by the updater after a snapshot — DESIGN §12).
 */
const opened = createDb({ path: `${dataDir}/yoal.db` });

export const sqlite = opened.sqlite;
export const db = opened.db;

/** Better Auth's adapter needs the raw handle; the service layer uses `db`. */
export const authDatabase = sqlite;
