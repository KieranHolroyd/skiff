import { dkimSign } from 'mailauth';
import { parseAddress } from '@yoal/contracts';
import type { MailDomain } from './policy.ts';

/**
 * Message preparation before spooling: read the header block, make sure the headers Yoal relies
 * on exist, and DKIM-sign with the From: domain's keys (EMAIL.md §3.2, D116).
 */

export interface HeaderBlock {
	/** Raw header lines (with folding preserved), without the blank separator line. */
	head: string;
	body: Buffer;
	/** Unfolded, lowercase name → values. */
	values: Map<string, string[]>;
}

export function splitHeaders(raw: Buffer): HeaderBlock {
	let index = raw.indexOf('\r\n\r\n');
	let sepLength = 4;
	if (index === -1) {
		index = raw.indexOf('\n\n');
		sepLength = 2;
	}
	const head = index === -1 ? raw.toString('latin1') : raw.subarray(0, index).toString('latin1');
	const body = index === -1 ? Buffer.alloc(0) : raw.subarray(index + sepLength);
	const values = new Map<string, string[]>();
	const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
	for (const line of unfolded.split(/\r?\n/)) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		values.set(name, [...(values.get(name) ?? []), value]);
	}
	return { head, body, values };
}

/** The address in a From: header (`"Name" <a@b.c>` or `a@b.c`). Exactly one mailbox is allowed. */
export function headerFromAddress(value: string | undefined): string | null {
	if (!value) return null;
	const angle = /<([^<>]+)>/.exec(value);
	const candidate = (angle ? angle[1]! : value).trim();
	if (!angle && candidate.includes(',')) return null;
	return parseAddress(candidate)?.address ?? null;
}

function domainOf(address: string): string {
	return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Add `Message-ID` and `Date` when missing and the `X-Yoal-Id` trace header (complaint reports
 * carry it back, §6.4). Any caller-supplied `X-Yoal-*` header is dropped first.
 */
export function prepareHeaders(raw: Buffer, messageId: string, fromAddress: string, now: Date): Buffer {
	const { head, body, values } = splitHeaders(raw);
	// Group physical lines into logical headers (continuations start with whitespace).
	const fields: string[][] = [];
	for (const line of head.split(/\r?\n/)) {
		if (line.length === 0) continue;
		if (/^[ \t]/.test(line) && fields.length > 0) fields.at(-1)!.push(line);
		else fields.push([line]);
	}
	const kept = fields.filter((field) => !/^x-yoal-/i.test(field[0]!)).map((field) => field.join('\r\n'));
	const added: string[] = [];
	if (!values.has('message-id')) added.push(`Message-ID: <${messageId}@${domainOf(fromAddress)}>`);
	if (!values.has('date')) added.push(`Date: ${now.toUTCString().replace('GMT', '+0000')}`);
	if (!values.has('mime-version')) added.push('MIME-Version: 1.0');
	added.push(`X-Yoal-Id: ${messageId}`);
	return Buffer.concat([Buffer.from(`${[...kept, ...added].join('\r\n')}\r\n\r\n`, 'latin1'), body]);
}

/** Prepend DKIM-Signature headers for every key the domain has. */
export async function signMessage(raw: Buffer, domain: MailDomain): Promise<Buffer> {
	if (domain.dkim.length === 0) throw new Error(`no DKIM key for ${domain.name}`);
	const result = await dkimSign(raw, {
		canonicalization: 'relaxed/relaxed',
		signatureData: domain.dkim.map((key) => ({
			signingDomain: domain.name,
			selector: key.selector,
			privateKey: key.privateKey,
			algorithm: key.algorithm,
		})),
	});
	if (result.errors.length > 0) throw new Error(`DKIM signing failed: ${String(result.errors[0]?.err ?? 'unknown error')}`);
	return Buffer.concat([Buffer.from(result.signatures, 'latin1'), raw]);
}
