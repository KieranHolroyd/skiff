/**
 * Re-exports for the e2e suite in `tests/e2e/studio`, where `mysql2` and `@yoal/contracts`
 * do not resolve (they are dependencies of this package only). The suite uses a raw client to
 * seed fixtures as root and to watch the server's process list independently of the plugin.
 */
export { createConnection } from 'mysql2/promise';
export type { Connection, RowDataPacket } from 'mysql2/promise';
export { DEFAULT_STUDIO_LIMITS } from '@yoal/contracts';
