import { MailServer } from './server.ts';

/**
 * Entry point for `skiff-agent mail`, run by `skiff-mail.service` (EMAIL.md §3.2). Configuration
 * is environment only; the unit sets it. Nothing here reads the agent's config or token.
 */

function port(name: string, fallback: number | null): number | null {
	const value = process.env[name];
	if (value === undefined || value === '') return fallback;
	if (value === 'off') return null;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`${name} must be a port number or "off"`);
	return parsed;
}

export async function runMailProcess(): Promise<void> {
	const server = new MailServer({
		dataDir: process.env.SKIFF_MAIL_DATA_DIR ?? '/var/lib/skiff/mail',
		controlSocket: process.env.SKIFF_MAIL_SOCKET ?? '/run/skiff/mail.sock',
		tlsDir: process.env.SKIFF_MAIL_TLS_DIR ?? '/run/skiff/mail-tls',
		listen: {
			host: process.env.SKIFF_MAIL_LISTEN ?? '0.0.0.0',
			inbound: port('SKIFF_MAIL_PORT_INBOUND', 25),
			submission: port('SKIFF_MAIL_PORT_SUBMISSION', 587),
			submissions: port('SKIFF_MAIL_PORT_SUBMISSIONS', 465),
		},
		deliveryPort: port('SKIFF_MAIL_DELIVERY_PORT', 25) ?? 25,
		ipv6: process.env.SKIFF_MAIL_IPV6 === '1',
	});
	await server.start();
	console.log(`[skiff-mail] listening; spool ${process.env.SKIFF_MAIL_DATA_DIR ?? '/var/lib/skiff/mail'}`);
	const shutdown = async (signal: string) => {
		console.log(`[skiff-mail] ${signal}: stopping`);
		await server.stop();
		process.exit(0);
	};
	// Bun's process typings only list its own events; the signals are standard Node ones.
	const signals = process as unknown as { once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void };
	signals.once('SIGTERM', () => void shutdown('SIGTERM'));
	signals.once('SIGINT', () => void shutdown('SIGINT'));
}
