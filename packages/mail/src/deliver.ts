import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { classifyNetworkError, classifyReply, type ReplyOutcome } from './classify.ts';
import { DeliveryDnsError, resolveTargets, type MailResolver, type MxTarget } from './dns.ts';

/**
 * Outbound delivery to one recipient domain (EMAIL.md §3.2).
 *
 * Each recipient is its own SMTP transaction, because each has its own VERP return path (D116),
 * but transactions to the same domain share one connection. MX hosts are tried in priority order
 * until one accepts the connection; a connection that drops mid-batch leaves the rest transient.
 */

export interface DeliveryItem {
	key: string;
	envelopeFrom: string;
	recipient: string;
	raw: Buffer;
}

export interface DeliveryResult {
	key: string;
	outcome: ReplyOutcome;
	response: string;
	remoteHost: string | null;
	tls: boolean | null;
}

export interface DeliveryOptions {
	resolver: MailResolver;
	helo: string;
	/** 25 in production; tests point at a fake MX. */
	port: number;
	ipv6?: boolean;
	localAddress?: string;
	connectionTimeoutMs?: number;
	greetingTimeoutMs?: number;
	socketTimeoutMs?: number;
}

interface SmtpError extends Error {
	code?: string;
	responseCode?: number;
	response?: string;
}

const trim = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 1000);

function connect(target: MxTarget, options: DeliveryOptions): Promise<SMTPConnection> {
	return new Promise((resolve, reject) => {
		const connection = new SMTPConnection({
			host: target.address,
			port: options.port,
			name: options.helo,
			secure: false,
			opportunisticTLS: true,
			localAddress: options.localAddress,
			connectionTimeout: options.connectionTimeoutMs ?? 30_000,
			greetingTimeout: options.greetingTimeoutMs ?? 60_000,
			socketTimeout: options.socketTimeoutMs ?? 180_000,
			// Opportunistic TLS to MX hosts: encrypt when offered, but most MX certificates don't
			// match the MX name, and refusing would only fall back to plaintext elsewhere.
			tls: { rejectUnauthorized: false, servername: target.host },
		});
		let settled = false;
		connection.on('error', (error: SmtpError) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		connection.connect(() => {
			if (settled) return;
			settled = true;
			resolve(connection);
		});
	});
}

function send(connection: SMTPConnection, item: DeliveryItem): Promise<string> {
	return new Promise((resolve, reject) => {
		connection.send({ from: item.envelopeFrom, to: [item.recipient] }, item.raw, (error, info) => {
			if (error) reject(error);
			else resolve(info.response ?? '250 OK');
		});
	});
}

function reset(connection: SMTPConnection): Promise<void> {
	return new Promise((resolve, reject) => connection.reset((error) => (error ? reject(error) : resolve())));
}

function errorOutcome(error: SmtpError): { outcome: ReplyOutcome; response: string } {
	if (error.responseCode) {
		const response = trim(error.response ?? `${error.responseCode} ${error.message}`);
		return { outcome: classifyReply(error.responseCode, response), response };
	}
	return { outcome: classifyNetworkError(error.code), response: trim(`${error.code ?? 'ERROR'} ${error.message}`) };
}

/** True when the failure is about the connection, not the recipient, so the next MX may do better. */
function connectionLevel(error: SmtpError): boolean {
	if (!error.responseCode) return true;
	return error.responseCode === 421;
}

export async function deliverDomain(domain: string, items: DeliveryItem[], options: DeliveryOptions): Promise<DeliveryResult[]> {
	if (items.length === 0) return [];
	let targets: MxTarget[];
	try {
		targets = await resolveTargets(options.resolver, domain, { ipv6: options.ipv6 });
	} catch (error) {
		const permanent = error instanceof DeliveryDnsError && error.code === 'EBADDOMAIN';
		const outcome: ReplyOutcome = permanent
			? { kind: 'permanent', bounceClass: 'bad-domain' }
			: { kind: 'transient', bounceClass: 'connection' };
		return items.map((item) => ({ key: item.key, outcome, response: trim(String((error as Error).message)), remoteHost: null, tls: null }));
	}

	const results = new Map<string, DeliveryResult>();
	let pending = items;
	let lastFailure: { outcome: ReplyOutcome; response: string; host: string | null } = {
		outcome: { kind: 'transient', bounceClass: 'connection' },
		response: `no MX for ${domain} accepted a connection`,
		host: null,
	};

	for (const target of targets) {
		if (pending.length === 0) break;
		let connection: SMTPConnection;
		try {
			connection = await connect(target, options);
		} catch (error) {
			const { outcome, response } = errorOutcome(error as SmtpError);
			lastFailure = { outcome: outcome.kind === 'permanent' ? { kind: 'transient', bounceClass: outcome.bounceClass } : outcome, response, host: target.host };
			continue;
		}
		const tls = connection.secure;
		const remaining: DeliveryItem[] = [];
		let broken = false;
		for (const item of pending) {
			if (broken) {
				remaining.push(item);
				continue;
			}
			try {
				const response = await send(connection, item);
				results.set(item.key, { key: item.key, outcome: { kind: 'delivered' }, response: trim(response), remoteHost: target.host, tls });
			} catch (error) {
				const smtpError = error as SmtpError;
				if (connectionLevel(smtpError)) {
					const { outcome, response } = errorOutcome(smtpError);
					// A 421 throttle answers for the whole provider; record it and stop here.
					if (smtpError.responseCode === 421) {
						results.set(item.key, { key: item.key, outcome, response, remoteHost: target.host, tls });
						for (const rest of pending.slice(pending.indexOf(item) + 1))
							results.set(rest.key, { key: rest.key, outcome, response, remoteHost: target.host, tls });
						broken = true;
						pending = [];
						break;
					}
					lastFailure = { outcome, response, host: target.host };
					broken = true;
					remaining.push(item);
					continue;
				}
				const { outcome, response } = errorOutcome(smtpError);
				results.set(item.key, { key: item.key, outcome, response, remoteHost: target.host, tls });
				try {
					await reset(connection);
				} catch {
					broken = true;
				}
			}
		}
		try {
			connection.quit();
		} catch {
			connection.close();
		}
		if (pending.length > 0) pending = remaining;
	}

	for (const item of pending)
		if (!results.has(item.key))
			results.set(item.key, { key: item.key, outcome: lastFailure.outcome, response: lastFailure.response, remoteHost: lastFailure.host, tls: null });
	return items.map((item) => results.get(item.key)!);
}
