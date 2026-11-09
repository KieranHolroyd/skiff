#!/usr/bin/env bun
/**
 * Runs once during install (after the control plane has applied its schema) and enrolls the local
 * machine as the edge node. It talks to the same service layer as the API, but uses a system
 * principal because the first admin does not exist yet.
 *
 * Writes /etc/yoal/agent.env with the node identity and the Caddy/agent settings.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	LocalObjectStore,
	buildPrincipal,
	createCore,
} from '../../packages/core/src/index.ts';
import { createDb } from '../../packages/db/src/index.ts';

const env = process.env;
function required(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

const dataDir = required('YOAL_DATA_DIR');
const platformOrigin = required('YOAL_PLATFORM_ORIGIN');
const contentDomain = required('YOAL_CONTENT_DOMAIN');
const siteCookieSecret = required('YOAL_SITE_COOKIE_SECRET');
const objectStoreSecret = required('YOAL_OBJECT_STORE_SECRET');
// The installer passes the key itself when it is sealed with systemd-creds (no plaintext file).
const masterKeyValue = env.YOAL_MASTER_KEY || readFileSync(required('YOAL_MASTER_KEY_FILE'), 'utf8');
const agentEnvFile = required('YOAL_AGENT_ENV_FILE');
const platformHost = required('YOAL_PLATFORM_HOST');
const platformUpstream = required('YOAL_PLATFORM_UPSTREAM');
const acmeEmail = env.YOAL_ACME_EMAIL ?? '';
const cloudflareTokenFile = env.YOAL_CLOUDFLARE_API_TOKEN_FILE ?? '';
const caddyAdminSocket = env.YOAL_CADDY_ADMIN_SOCKET ?? '/var/lib/caddy/admin.sock';
/** D105: the edge agent reaches the control plane on its socket instead of through Caddy. */
const controlSocket = env.YOAL_CONTROL_SOCKET ?? '';

mkdirSync(dirname(agentEnvFile), { recursive: true });
const { db, sqlite } = createDb({ path: `${dataDir}/yoal.db` });
const core = createCore({
	db,
	sqlite,
	version: '0.1.0',
	config: {
		dataDir,
		platformOrigin,
		contentDomain,
		objectStore: new LocalObjectStore(`${dataDir}/objects`, platformOrigin, objectStoreSecret),
		masterKey: Buffer.from(masterKeyValue.trim(), 'base64'),
		siteCookieSecret,
		objectStoreSecret,
		desiredAgentVersion: '0.1.0',
	},
});

// System principal: this is the installer bootstrap, never a user-facing surface.
const principal = buildPrincipal({
	kind: 'system',
	userId: 'installer',
	orgId: 'system',
	role: 'owner',
});

const existing = sqlite
	.query<{ id: string; name: string }, []>("SELECT id, name FROM nodes ORDER BY created_at ASC LIMIT 1")
	.get();
let nodeId: string;
let token: string;
let mode: string;
if (existing) {
	// Reuse the edge node on re-install/upgrade, but rotate a token for the local agent.
	nodeId = existing.id;
	mode = 'edge';
	token = core.nodes.rotateToken(principal, nodeId).token;
} else {
	const join = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
	nodeId = join.nodeId;
	token = join.token;
	mode = join.mode;
}

const agentEnv = [
	`YOAL_CONTROL_URL=${platformOrigin}`,
	...(controlSocket ? [`YOAL_CONTROL_SOCKET=${controlSocket}`] : []),
	`YOAL_NODE_ID=${nodeId}`,
	`YOAL_NODE_TOKEN=${token}`,
	`YOAL_NODE_MODE=${mode}`,
	`YOAL_DATA_DIR=/var/lib/yoal/agent`,
	`YOAL_CONTENT_DOMAIN=${contentDomain}`,
	`YOAL_PLATFORM_HOST=${platformHost}`,
	`YOAL_PLATFORM_UPSTREAM=${platformUpstream}`,
	`YOAL_CADDY_ADMIN_SOCKET=${caddyAdminSocket}`,
	...(acmeEmail ? [`YOAL_ACME_EMAIL=${acmeEmail}`, 'YOAL_TLS=1'] : ['YOAL_TLS=0']),
	...(cloudflareTokenFile ? [`YOAL_CLOUDFLARE_API_TOKEN_FILE=${cloudflareTokenFile}`] : []),
	'',
].join('\n');
writeFileSync(`${agentEnvFile}.tmp`, agentEnv, { mode: 0o640 });
renameSync(`${agentEnvFile}.tmp`, agentEnvFile);

// A new release can change the compiled routes; bump the watermark so every agent pulls again.
sqlite.run(
	'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at',
	['state_version', '1', Date.now()],
);

console.log(`enrolled ${nodeId} (${mode})`);
