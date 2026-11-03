#!/usr/bin/env bun
/**
 * Dev-only: enroll this machine as the local control plane's edge node.
 *
 * Mirrors `scripts/install/bootstrap-node.ts` (system principal, no dashboard session), but
 * runs against a development database and writes the agent state into a gitignored directory
 * instead of /etc/skiff + /var/lib/skiff.
 *
 *   SKIFF_DATA_DIR=apps/control-plane/.data-debug bun scripts/dev/enroll-agent.ts
 *
 * Environment:
 *   SKIFF_DATA_DIR      control-plane data dir (default apps/control-plane/.data-debug)
 *   SKIFF_AGENT_DIR     agent state dir (default .data-agent)
 *   SKIFF_PLATFORM_ORIGIN  agent -> control plane URL (default http://localhost:5173)
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	LocalObjectStore,
	buildPrincipal,
	coreConfigFromEnv,
	createCore,
} from '../../packages/core/src/index.ts';
import { createDb } from '../../packages/db/src/index.ts';

const repoRoot = resolve(import.meta.dir, '../..');
const controlDataDir = resolve(repoRoot, process.env.SKIFF_DATA_DIR ?? 'apps/control-plane/.data-debug');
const agentDir = resolve(repoRoot, process.env.SKIFF_AGENT_DIR ?? '.data-agent');
const platformOrigin = (process.env.SKIFF_PLATFORM_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
const dbPath = join(controlDataDir, 'skiff.db');

const { db, sqlite } = createDb({ path: dbPath });
const core = createCore({
	db,
	sqlite,
	version: 'dev',
	config: coreConfigFromEnv({
		dataDir: controlDataDir,
		platformOrigin,
		contentDomain: 'localhost',
		objectStore: new LocalObjectStore(
			join(controlDataDir, 'objects'),
			platformOrigin,
			'dev-object-store-secret',
		),
		masterKey: new Uint8Array(32),
		siteCookieSecret: 'dev-site-cookie-secret',
		objectStoreSecret: 'dev-object-store-secret',
	}),
});

// Installer principal: internal only, allowed to mint/rotate node credentials.
const principal = buildPrincipal({
	kind: 'system',
	userId: 'dev-enroll',
	orgId: 'system',
	role: 'owner',
});

const existing = sqlite
	.query<{ id: string; name: string }, []>(
		"SELECT id, name FROM nodes WHERE mode = 'edge' ORDER BY created_at ASC LIMIT 1",
	)
	.get();

let nodeId: string;
let token: string;
let action: 'created' | 'rotated';
if (existing) {
	nodeId = existing.id;
	token = core.nodes.rotateToken(principal, nodeId).token;
	action = 'rotated';
} else {
	const joined = core.nodes.join({
		token: core.nodes.createJoinToken(principal, 'edge').token,
		name: 'mac-dev',
	});
	nodeId = joined.nodeId;
	token = joined.token;
	action = 'created';
}

mkdirSync(agentDir, { recursive: true, mode: 0o755 });
const suffix = `.tmp-${process.pid}`;

const nodeFile = {
	controlUrl: platformOrigin,
	nodeId,
	token,
	mode: 'edge',
	joinedAt: new Date().toISOString(),
};
writeFileSync(`${agentDir}/node.json${suffix}`, `${JSON.stringify(nodeFile, null, 2)}\n`, { mode: 0o600 });
renameSync(`${agentDir}/node.json${suffix}`, `${agentDir}/node.json`);

const envFile = [
	`SKIFF_CONTROL_URL=${platformOrigin}`,
	`SKIFF_NODE_ID=${nodeId}`,
	`SKIFF_NODE_TOKEN=${token}`,
	'SKIFF_NODE_MODE=edge',
	`SKIFF_DATA_DIR=${agentDir}`,
	'SKIFF_AGENT_INSECURE_HTTP=1',
	'SKIFF_TLS=0',
	'SKIFF_CONTENT_DOMAIN=localhost',
	'SKIFF_PLATFORM_HOST=localhost',
	'SKIFF_PLATFORM_UPSTREAM=localhost:5173',
	// Caddy is not installed for the agent-only dev setup; the socket is where it will appear.
	`SKIFF_CADDY_ADMIN_SOCKET=${agentDir}/caddy-admin.sock`,
	`SKIFF_AGENT_SOCKET=${agentDir}/agent.sock`,
	`SKIFF_HELPER_SOCKET=${agentDir}/helper.sock`,
	`SKIFF_WORKLOAD_SOCKET_DIR=${agentDir}/workloads`,
	'SKIFF_CERT_PROBE_ADDR=off',
	'',
].join('\n');
writeFileSync(`${agentDir}/agent.env${suffix}`, envFile, { mode: 0o600 });
renameSync(`${agentDir}/agent.env${suffix}`, `${agentDir}/agent.env`);

const runScript = `#!/bin/sh
# Dev launcher: load the enrolled node env and run the agent from this checkout.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
set -a
. "$here/agent.env"
set +a
exec "\${SKIFF_AGENT_BIN:-skiff-agent}" "\$@"
`;
writeFileSync(`${agentDir}/run-agent.sh${suffix}`, runScript, { mode: 0o755 });
renameSync(`${agentDir}/run-agent.sh${suffix}`, `${agentDir}/run-agent.sh`);

console.log(`${action} node ${nodeId}`);
console.log(`database: ${dbPath}`);
console.log(`agent dir: ${agentDir}`);
console.log(`start:    ${agentDir}/run-agent.sh`);
sqlite.close();
