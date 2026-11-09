/**
 * Custom project domains (DESIGN §5, D31). Verification and certificate issuance live on the
 * platform; this file describes the view and renders it.
 */
import { formatTime, renderTable } from './output.ts';

export type DomainStatus = 'pending' | 'verified' | 'active' | 'failed';
export type DomainKind = 'custom' | 'apex';

export interface DomainView {
	id: string;
	projectId: string;
	projectSlug: string;
	hostname: string;
	kind: DomainKind;
	status: DomainStatus;
	verification: { recordName: string; recordValue: string } | null;
	redirectWww: boolean;
	wwwHostname: string | null;
	lastCheckedAt: string | null;
	lastError: string | null;
	createdAt: string;
	verifiedAt: string | null;
}

export interface DomainRecord {
	type: 'TXT' | 'CNAME' | 'A' | 'AAAA';
	name: string;
	value: string;
}

export interface DomainCheckResult {
	domain: DomainView;
	detail: string;
	records: DomainRecord[];
}

export function domainTable(domains: DomainView[]): string {
	const rows = domains.map((domain) => [
		domain.hostname,
		domain.projectSlug,
		domain.kind,
		domain.status,
		domain.redirectWww ? (domain.wwwHostname ?? 'www') : '-',
		domain.lastCheckedAt ? formatTime(domain.lastCheckedAt) : 'never',
	]);
	return renderTable(['HOSTNAME', 'PROJECT', 'KIND', 'STATUS', 'WWW', 'LAST CHECKED'], rows);
}

/** DNS records an operator still has to create, as `TYPE NAME VALUE` lines. */
export function recordLines(records: DomainRecord[]): string[] {
	return records.map((record) => `${record.type.padEnd(6)} ${record.name}  →  ${record.value}`);
}

export function recordTable(records: DomainRecord[]): string {
	return renderTable(
		['TYPE', 'NAME', 'VALUE'],
		records.map((record) => [record.type, record.name, record.value]),
	);
}

/** The records shown right after `domains add`, before DNS has been checked. */
export function addRecordLines(
	domain: Pick<DomainView, 'hostname' | 'redirectWww' | 'wwwHostname' | 'verification'>,
	target: { type: 'A' | 'CNAME'; value: string },
): string[] {
	const lines: string[] = [];
	const hostnames = domain.redirectWww && domain.wwwHostname ? [domain.hostname, domain.wwwHostname] : [domain.hostname];
	for (const hostname of hostnames) lines.push(`${target.type.padEnd(6)} ${hostname}  →  ${target.value}`);
	if (domain.verification)
		lines.push(`TXT    ${domain.verification.recordName}  →  ${domain.verification.recordValue}`);
	return lines;
}
