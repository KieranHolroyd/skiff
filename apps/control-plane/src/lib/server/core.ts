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
	features,
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
		storageGatewayPort,
		storageGatewayUrl,
		notifiers,
		email: emailTransport,
		features,
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
	// DuckDB allows one process per file. A zero-downtime standby must leave it to the primary,
	// or the primary restarted behind the standby finds the file locked.
	disabledReason: process.env.SKIFF_STANDBY === '1' ? 'this is a standby serving an update' : undefined,
});
core.ctx.telemetry = telemetry;
// Never load the DuckDB native addon while SvelteKit analyses the build.
if (!building && process.env.SKIFF_STANDBY !== '1') {
	void telemetry.open().catch((error) => console.error('[telemetry] open failed:', error));
}

