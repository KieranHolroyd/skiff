/**
 * MySQL/MariaDB studio plugin (plan 22, track B), on `mysql2`. Bun.SQL is not used: it buffers
 * whole results and cannot cancel a running query (spike S2).
 *
 * The session is scoped to `target.database`, so the tree root lists tables and views
 * directly (`schemas: false`).
 */
import type { DatabaseEngine } from '@yoal/contracts';
import type { StudioPlugin } from '../../driver.ts';
import type { StudioCapabilities } from '../../protocol.ts';
import { MYSQL_STRUCTURE } from './ddl.ts';
import { MysqlSession } from './session.ts';

export const mysqlPlugin: StudioPlugin = {
	id: 'mysql',
	engines: ['mysql', 'mariadb'],
	capabilities(engine: DatabaseEngine): StudioCapabilities {
		return {
			family: 'relational',
			language: 'sql',
			dialect: engine === 'mariadb' ? 'mariadb' : 'mysql',
			edit: 'primary-key',
			cancel: 'kill-connection',
			explain: true,
			schemas: false,
			structure: [...MYSQL_STRUCTURE],
		};
	},
	connect: (target, options) => MysqlSession.open(target, options),
};
