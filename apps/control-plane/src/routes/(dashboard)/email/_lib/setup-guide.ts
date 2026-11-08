import type { EmailOrgState } from '@skiff/contracts';

/**
 * The Email setup checklist on the overview (docs/EMAIL.md §9): the steps from "nothing configured"
 * to "an app sends real mail", each judged from live state. Pure, so the ordering and the done rules are tested
 * directly; the page only renders what this returns.
 */

export const setupStepIds = [
	'node',
	'reverse-dns',
	'domain',
	'verify',
	'test',
	'connect',
	'sandbox'
] as const;
export type SetupStepId = (typeof setupStepIds)[number];

/** Result of the forward-confirmed reverse DNS check on the mail node's IP. */
export type ReverseDnsState = 'ok' | 'missing' | 'mismatch' | 'unknown';

/** What the control plane's resolver found for the mail node (reverse-dns.server.ts). */
export interface ReverseDnsCheck {
	state: ReverseDnsState;
	ip: string;
	helo: string;
	/** What the PTR lookup returned, shown when it doesn't match. */
	ptr: string[];
}

export interface SetupFacts {
	/** A platform admin picked a mail node (Email → Mail server, or the checklist's first step). */
	nodeChosen: boolean;
	/** FCrDNS on the mail node's IPv4; null while checking or when there is no IP to check. */
	reverseDns: ReverseDnsState | null;
	domains: number;
	verifiedDomains: number;
	/** At least one message reached a recipient's server. */
	delivered: boolean;
	/** SMTP credentials that exist, and whether anything but the dashboard has sent. */
	credentials: number;
	appSent: boolean;
	orgState: EmailOrgState | null;
}

/** Who has to act: the org's own members, or a platform admin. */
export type SetupOwner = 'org' | 'platform';

export type SetupStepState = 'done' | 'current' | 'upcoming';

export interface SetupStep {
	id: SetupStepId;
	title: string;
	owner: SetupOwner;
	state: SetupStepState;
}

const STEPS: Record<
	SetupStepId,
	{ title: string; owner: SetupOwner; done: (f: SetupFacts) => boolean }
> = {
	node: { title: 'Choose the mail node', owner: 'platform', done: (f) => f.nodeChosen },
	'reverse-dns': {
		title: 'Point reverse DNS at the mail node',
		owner: 'platform',
		done: (f) => f.reverseDns === 'ok'
	},
	domain: { title: 'Add a sending domain', owner: 'org', done: (f) => f.domains > 0 },
	verify: {
		title: 'Publish its DNS records',
		owner: 'org',
		done: (f) => f.verifiedDomains > 0
	},
	test: { title: 'Send a test message', owner: 'org', done: (f) => f.delivered },
	connect: {
		title: 'Connect your app',
		owner: 'org',
		done: (f) => f.credentials > 0 || f.appSent
	},
	sandbox: {
		title: 'Leave the sandbox',
		owner: 'platform',
		done: (f) => f.orgState === 'active'
	}
};

/**
 * Every step with its state. Steps can finish out of order (a domain can be added before a node is
 * picked); `current` is the first one that isn't done, so the page always points at one next move.
 */
export function setupSteps(facts: SetupFacts): SetupStep[] {
	let currentTaken = false;
	return setupStepIds.map((id) => {
		const step = STEPS[id];
		let state: SetupStepState;
		if (step.done(facts)) state = 'done';
		else if (!currentTaken) {
			state = 'current';
			currentTaken = true;
		} else state = 'upcoming';
		return { id, title: step.title, owner: step.owner, state };
	});
}

/** `3 of 7`, and whether everything is done. */
export function setupProgress(steps: readonly SetupStep[]): {
	done: number;
	total: number;
	complete: boolean;
	percent: number;
} {
	const done = steps.filter((step) => step.state === 'done').length;
	return {
		done,
		total: steps.length,
		complete: done === steps.length,
		percent: steps.length ? (done / steps.length) * 100 : 0
	};
}

/** Whether anything other than the dashboard's "Send a test" has sent mail. */
export function sentFromApp(
	messages: ReadonlyArray<{ source: string; tags: Record<string, string> }>
): boolean {
	return messages.some(
		(message) =>
			message.source === 'smtp' ||
			message.source === 'binding' ||
			(message.source === 'api' && message.tags.source !== 'dashboard-test')
	);
}

/** Lower-case and drop the trailing root dot, so `MX1.Example.com.` matches `mx1.example.com`. */
function hostKey(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Judge forward-confirmed reverse DNS from what the resolver returned: the IP's PTR must name the
 * HELO host, and that host must resolve back to the IP (EMAIL.md §2). `null` lookups failed.
 */
export function judgeReverseDns(input: {
	ip: string;
	helo: string;
	ptr: string[] | null;
	forward: string[] | null;
}): ReverseDnsState {
	if (input.ptr === null) return 'unknown';
	if (input.ptr.length === 0) return 'missing';
	const named = input.ptr.some((name) => hostKey(name) === hostKey(input.helo));
	if (!named) return 'mismatch';
	if (input.forward === null) return 'unknown';
	return input.forward.includes(input.ip) ? 'ok' : 'mismatch';
}
