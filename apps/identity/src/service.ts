import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	createCore,
	LocalObjectStore,
	type Core,
	type CoreConfig,
} from '@skiff/core';
import { openIdentityDb } from '@skiff/db';
import type { Database } from 'bun:sqlite';
import type { SkiffDb } from '@skiff/db';
import { identityCookieSecret, type IdentityConfig } from './config.ts';
import { createIdentityControlHandler, createIdentityHandler } from './server.ts';

export interface IdentityRuntime {
	core: Core;
	sqlite: Database;
	db: SkiffDb;
	stop(): Promise<void>;
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/**
 * The identity process itself (docs/IAM.md §11.2). It owns one SQLite file on the node's disk,
 * created from the same forward-only migrations as the control plane, and listens twice:
 *
 * - loopback HTTP for Caddy (`127.0.0.1:8788`), serving the issuer/hosted-page surface;
 * - a private unix socket for the node agent (`/run/skiff/identity.sock`), which pushes the
 *   non-secret pool projection and reads health.
 *
 * It never dials the control plane. The `skiff-mail` pattern is deliberate: one cgroup, one data
 * directory, and no node token in this process.
 */
export async function createIdentityRuntime(
	config: IdentityConfig,
	options: { log?: Log } = {},
): Promise<IdentityRuntime> {
	mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
	const { sqlite, db } = openIdentityDb({ path: config.dbPath });
	const cookieSecret = identityCookieSecret(config.masterKey);
	const objectStore = new LocalObjectStore(join(config.dataDir, 'objects'), config.platformOrigin, cookieSecret);
	const coreConfig: CoreConfig = {
		dataDir: config.dataDir,
		platformOrigin: config.platformOrigin,
		contentDomain: config.contentDomain,
		objectStore,
		masterKey: config.masterKey,
		siteCookieSecret: cookieSecret,
		objectStoreSecret: cookieSecret,
		now: () => Date.now(),
	};
	const core = createCore({ db, sqlite, config: coreConfig, version: 'identity' });

	// Pool mail is a separate concern (skiff-mail or an operator SMTP relay); when a control-plane
	// URL is configured, forward the already-rendered message and keep the link out of logs.
	const mailUrl = process.env.SKIFF_IDENTITY_MAIL_URL?.trim();
	const mailToken = process.env.SKIFF_IDENTITY_MAIL_TOKEN?.trim();
	if (mailUrl) {
		core.ctx.userPoolMail = {
			async send(message) {
				const response = await fetch(mailUrl, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(mailToken ? { authorization: `Bearer ${mailToken}` } : {}),
					},
					body: JSON.stringify({
						to: message.to,
						subject: message.subject,
						text: message.text,
						poolId: message.poolId,
						purpose: message.purpose,
					}),
				});
				if (!response.ok) throw new Error(`identity mail -> ${response.status}`);
			},
		};
	}

	const publicServer = Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: createIdentityHandler({
			core,
			sqlite,
			secureCookies: config.secureCookies,
			...(options.log ? { log: options.log } : {}),
		}),
	});
	rmSync(config.socketPath, { force: true });
	mkdirSync(dirname(config.socketPath), { recursive: true, mode: 0o755 });
	const controlServer = Bun.serve({
		unix: config.socketPath,
		fetch: createIdentityControlHandler({
			sqlite,
			...(options.log ? { log: options.log } : {}),
		}),
	});
	chmodSync(config.socketPath, 0o660);
	options.log?.(
		'info',
		`skiff-identity listening on ${config.host}:${config.port} and unix/${config.socketPath} (db ${config.dbPath})`,
	);

	return {
		core,
		sqlite,
		db,
		async stop() {
			publicServer.stop(true);
			controlServer.stop(true);
			sqlite.close();
		},
	};
}
