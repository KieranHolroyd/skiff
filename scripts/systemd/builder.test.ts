import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDER_LINK, BUILDER_UNIT, builderUnit, ensureBuilder, linkAgentCommands, STORAGE_LINK } from './builder.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-builder-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('skiff-builder.service', () => {
	test('runs the agent binary through the builder link, gated on enrolment and the link', () => {
		const unit = builderUnit({ optDir: '/opt/skiff', agentEnvFile: '/etc/skiff/agent.env' });
		expect(unit).toContain(`ExecStart=/opt/skiff/current/agent/${BUILDER_LINK} builder`);
		expect(unit).toContain('ConditionPathExists=/etc/skiff/agent.env');
		expect(unit).toContain(`ConditionPathExists=/opt/skiff/current/agent/${BUILDER_LINK}`);
		expect(unit).toContain('Environment=SKIFF_BUILDER_USER=skiff-build');
		expect(unit).toContain('PartOf=skiff-agent.service');
	});

	test('linkAgentCommands marks a release that has an agent binary, idempotently (builder and storage links)', () => {
		const release = join(root, 'release');
		linkAgentCommands(release);
		expect(existsSync(join(release, 'agent', BUILDER_LINK))).toBe(false);
		mkdirSync(join(release, 'agent'), { recursive: true });
		writeFileSync(join(release, 'agent', 'skiff-agent'), '');
		linkAgentCommands(release);
		linkAgentCommands(release);
		expect(readlinkSync(join(release, 'agent', BUILDER_LINK))).toBe('skiff-agent');
		expect(readlinkSync(join(release, 'agent', STORAGE_LINK))).toBe('skiff-agent');
	});

	test('ensureBuilder creates the account once and only reloads systemd when the unit changes', () => {
		const systemdDir = join(root, 'systemd');
		mkdirSync(systemdDir);
		const agentEnvFile = join(root, 'agent.env');
		writeFileSync(agentEnvFile, 'SKIFF_NODE_TOKEN=x\n');
		const calls: string[] = [];
		let userExists = false;
		const options = {
			systemdDir,
			agentEnvFile,
			run: (cmd: string[]) => {
				calls.push(cmd.join(' '));
				if (cmd[0] === 'useradd') userExists = true;
			},
			capture: (cmd: string[]) => (cmd[0] === 'id' && userExists ? '999' : null),
		};
		expect(ensureBuilder(options)).toBe(true);
		expect(readFileSync(join(systemdDir, BUILDER_UNIT), 'utf8')).toBe(builderUnit({ agentEnvFile }));
		expect(calls.filter((call) => call.startsWith('useradd'))).toHaveLength(1);
		expect(calls).toContain(`systemctl restart ${BUILDER_UNIT}`);

		calls.length = 0;
		expect(ensureBuilder(options)).toBe(false);
		expect(calls).toEqual([`systemctl enable ${BUILDER_UNIT}`, `systemctl start ${BUILDER_UNIT}`]);
	});
});
