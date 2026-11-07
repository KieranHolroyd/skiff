import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_COMMANDS, RELEASE_COMMANDS } from './install/commands.ts';
import { CONFIG_COMMAND, CONFIG_PATH_UNIT, CONFIG_SERVICE_UNIT } from './platform-config/units.ts';
import { AGENT_UNIT } from './systemd/agent.ts';
import { BUILDER_UNIT } from './systemd/builder.ts';
import { CADDY_UNIT } from './systemd/caddy.ts';
import { CLICKHOUSE_UNIT } from './systemd/clickhouse.ts';
import { DEFAULT_CONTROL_PLANE_PATHS, GUARD_UNIT, PRIMARY_UNIT, STANDBY_UNIT } from './systemd/control-plane.ts';
import { HELPER_UNIT } from './systemd/helper.ts';
import { MAIL_UNIT } from './systemd/mail.ts';
import { STORAGE_PATH_UNIT, STORAGE_SERVICE_UNIT } from './systemd/storage.ts';
import { STUDIO_UNIT } from './systemd/studio.ts';
import { TRIGGER_PATH_UNIT, TRIGGER_SERVICE_UNIT } from './update-self/units.ts';

const SCRIPT = join(import.meta.dir, 'uninstall.sh');
const script = readFileSync(SCRIPT, 'utf8');

/** The whitespace-separated words of a `NAME="..."` block in the script. */
function list(name: string): string[] {
	const match = new RegExp(`^${name}="\\n([^"]*)"`, 'm').exec(script);
	if (!match) throw new Error(`no ${name} list in uninstall.sh`);
	return match[1]!.split(/\s+/).filter(Boolean);
}

describe('uninstall.sh', () => {
	test('is valid POSIX sh', () => {
		expect(spawnSync('sh', ['-n', SCRIPT]).status).toBe(0);
	});

	test('stops and removes every unit the installer and updater write', () => {
		const shipped = readdirSync(join(import.meta.dir, 'systemd')).filter((name) => /^skiff-.*\.(service|timer|path)$/.test(name));
		const written = [
			PRIMARY_UNIT,
			STANDBY_UNIT,
			GUARD_UNIT,
			TRIGGER_PATH_UNIT,
			TRIGGER_SERVICE_UNIT,
			CONFIG_PATH_UNIT,
			CONFIG_SERVICE_UNIT,
			HELPER_UNIT,
			AGENT_UNIT,
			BUILDER_UNIT,
			CADDY_UNIT,
			CLICKHOUSE_UNIT,
			MAIL_UNIT,
			STORAGE_PATH_UNIT,
			STORAGE_SERVICE_UNIT,
			STUDIO_UNIT,
		];
		const units = list('UNITS');
		for (const unit of new Set([...shipped, ...written])) expect(units).toContain(unit);
		// The master key drop-ins and other overrides go with their directories.
		expect(script).toContain('rm -rf /etc/systemd/system/skiff-*.service.d');
	});

	test('removes every operator command the installer puts on the host', () => {
		const commands = list('COMMANDS');
		for (const path of [...CLI_COMMANDS, ...RELEASE_COMMANDS.map((command) => command.path), CONFIG_COMMAND, DEFAULT_CONTROL_PLANE_PATHS.updateCommand])
			expect(commands).toContain(path);
	});

	test('keeps the ClickHouse binary unless --purge', () => {
		expect(script).toContain('[ "$PURGE" != "1" ] && [ "$_entry" = "$OPT_DIR/clickhouse" ] && continue');
	});
});
