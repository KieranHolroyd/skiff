import { building } from '$app/env';
import {
	ConsoleEmailTransport,
	EmailNotifier,
	LocalObjectStore,
	R2ObjectStore,
	SmtpEmailTransport,
	TelemetryStore,
	WebhookNotifier,
	createCore,
	type Notifier,
} from '@skiff/core';
import {
	agentVersion,
	alertEmail,
	dataDir,
	edgeNodeId,
	masterKey,
	objectStoreKind,
	objectStoreSecret,
	platformOrigin,
	contentDomain,
	r2,
	siteCookieSecret,
	smtp,
	webhookUrl,
} from './config';
import { db, sqlite } from './db';
import { platformVersion } from './version';

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
		desiredAgentVersion: agentVersion,
		edgeNodeId,
		notifiers,
		email: emailTransport,
	},
});

export { objectStore };

/**
 * DuckDB telemetry (DESIGN §8). Opened lazily and fail-open: if the native binding cannot load,
 * the platform keeps serving and telemetry simply reports unavailable.
 */
export const telemetry = new TelemetryStore({
	path: `${dataDir}/telemetry.duckdb`,
	memoryLimitMb: 256,
	threads: 2,
	objectStore,
	onError: (error) => console.error('[telemetry]', error),
});
core.ctx.telemetry = telemetry;
// Never load the DuckDB native addon while SvelteKit analyses the build.
if (!building) {
	void telemetry.open().catch((error) => console.error('[telemetry] open failed:', error));
}

