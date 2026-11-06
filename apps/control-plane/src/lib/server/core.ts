import { building } from '$app/env';
import {
	ConsoleEmailTransport,
	EmailNotifier,
	LocalObjectStore,
	R2ObjectStore,
	SmtpEmailTransport,
	TelemetryStore,
	WebhookNotifier,
	clickhouseFromEnv,
	createCore,
	type Notifier
} from '@skiff/core';
import {
	alertEmail,
	clickhouseEnv,
	dataDir,
	edgeNodeId,
	masterKey,
	storageGatewayPort,
	storageGatewayUrl,
	objectStoreKind,
	objectStoreSecret,
	platformOrigin,
	contentDomain,
	r2,
	siteCookieSecret,
	smtp,
	webhookUrl,
	features
} from './config';
import { db, sqlite } from './db';
import { platformVersion } from './version';
import { updateSource } from './self-update';

const objectStore =
	objectStoreKind === 'r2' && r2
		? new R2ObjectStore(r2)
		: new LocalObjectStore(`${dataDir}/objects`, platformOrigin, objectStoreSecret);

const emailTransport = smtp ? new SmtpEmailTransport(smtp) : new ConsoleEmailTransport();
const notifiers: Notifier[] = [];
if (alertEmail) notifiers.push(new EmailNotifier(emailTransport, alertEmail));
if (webhookUrl) notifiers.push(new WebhookNotifier(webhookUrl));

/** The single service layer shared by the dashboard, REST API, MCP server and CLI (DESIGN §3.2). */
export const core = createCore({
	db,
	sqlite,
	version: platformVersion,
	config: {
		dataDir,
		platformOrigin,
		contentDomain,
		objectStore,
		masterKey,
		siteCookieSecret,
		objectStoreSecret,
		// Nodes should run this release (D99); the env value outlives the binary it was written for.
		desiredAgentVersion: platformVersion,
		releaseRepo: updateSource().repo,
		edgeNodeId,
		storageGatewayPort,
		storageGatewayUrl,
		notifiers,
		email: emailTransport,
		features
	}
});

export { objectStore };

/**
 * ClickHouse telemetry (DESIGN §8, D101), over HTTP to the local `skiff-clickhouse` server.
 * Fail-open: if ClickHouse is down or unconfigured, the platform keeps serving, telemetry
 * reports unavailable, and the store reconnects by itself once the server answers. A
 * zero-downtime standby shares the server with the primary, so it needs no special case.
 */
export const telemetry = new TelemetryStore({
	...clickhouseFromEnv(clickhouseEnv),
	objectStore,
	onError: (error) => console.error('[telemetry]', error.message)
});
core.ctx.telemetry = telemetry;
// Never connect while SvelteKit analyses the build.
if (!building) {
	void telemetry.open().catch((error) => console.error('[telemetry] open failed:', error));
}
