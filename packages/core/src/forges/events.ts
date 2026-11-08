import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook deliveries from GitHub, GitLab, Gitea and Forgejo, turned into one shape that git builds
 * and pipelines consume (docs/FORGES.md §3, D174). Pure: no I/O, so every format is unit tested.
 */

export type WebhookSource = 'github' | 'gitlab' | 'gitea' | 'forgejo';

export interface HeaderReader {
	get(name: string): string | null;
}

export interface ForgePushEvent {
	kind: 'push';
	/** `refs/heads/<branch>` or `refs/tags/<tag>`. */
	ref: string;
	/** The new head; null when the branch or tag was deleted. */
	after: string | null;
	deleted: boolean;
	/** Every added, modified or removed path; null when the forge truncated the commit list. */
	changedFiles: string[] | null;
	/** Added or modified paths of the listed commits (possibly incomplete). */
	addedOrModified: string[];
	message: string | null;
	actor: string | null;
	/** `owner/name` (or a nested GitLab path) as the forge names it. */
	fullName: string | null;
	cloneUrl: string | null;
	defaultBranch: string | null;
}

export interface ForgePullRequestEvent {
	kind: 'pull_request';
	/** GitHub's action names: `opened`, `synchronize`, `reopened`, `edited`, `ready_for_review`, `labeled`, or the forge's own for others. */
	action: string;
	number: number;
	title: string | null;
	headSha: string;
	headRef: string | null;
	baseRef: string | null;
	/** Head and base are the same repository (not a fork): the run may be trusted. */
	sameRepository: boolean;
	/** The ref a clone fetches: `refs/pull/<n>/head`, or GitLab's `refs/merge-requests/<iid>/head`. */
	fetchRef: string;
	actor: string | null;
	fullName: string | null;
}

export type ForgeEvent =
	| ForgePushEvent
	| ForgePullRequestEvent
	| { kind: 'ping' }
	| { kind: 'ignored'; reason: string };

/** Which forge sent a delivery, from its headers (Forgejo and Gitea also send GitHub's names). */
export function webhookSource(headers: HeaderReader): WebhookSource | null {
	if (headers.get('x-gitlab-event') || headers.get('x-gitlab-token')) return 'gitlab';
	if (headers.get('x-forgejo-event') || headers.get('x-forgejo-signature')) return 'forgejo';
	if (headers.get('x-gitea-event') || headers.get('x-gitea-signature')) return 'gitea';
	if (headers.get('x-github-event') || headers.get('x-hub-signature-256')) return 'github';
	return null;
}

function hmacHex(secret: string, rawBody: string): string {
	return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Check a delivery against `secret`: GitHub's `X-Hub-Signature-256`, Gitea/Forgejo's hex HMAC
 * (`X-Forgejo-Signature`/`X-Gitea-Signature`, or the GitHub header they also send), or GitLab's
 * `X-Gitlab-Token`, which carries the secret itself. Constant-time; false when nothing matches.
 */
export function verifyDelivery(source: WebhookSource, secret: string, rawBody: string, headers: HeaderReader): boolean {
	if (source === 'gitlab') {
		const token = headers.get('x-gitlab-token');
		return token !== null && safeEqual(token, secret);
	}
	const hex = hmacHex(secret, rawBody);
	if (source === 'gitea' || source === 'forgejo') {
		const signature = headers.get('x-forgejo-signature') ?? headers.get('x-gitea-signature');
		if (signature) return safeEqual(signature.trim().toLowerCase(), hex);
	}
	const hub = headers.get('x-hub-signature-256');
	return hub !== null && safeEqual(hub.trim(), `sha256=${hex}`);
}

/** The event name a forge put in its headers (`push`, `pull_request`, `Push Hook`, …). */
export function webhookEventName(source: WebhookSource, headers: HeaderReader): string | null {
	if (source === 'gitlab') return headers.get('x-gitlab-event');
	if (source === 'forgejo') return headers.get('x-forgejo-event') ?? headers.get('x-gitea-event') ?? headers.get('x-github-event');
	if (source === 'gitea') return headers.get('x-gitea-event') ?? headers.get('x-github-event');
	return headers.get('x-github-event');
}

type Json = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => arr(value).filter((entry): entry is string => typeof entry === 'string');

const ZERO_SHA = /^0+$/;

function fileLists(commits: unknown[]): { all: string[]; addedOrModified: string[] } {
	const all = new Set<string>();
	const addedOrModified = new Set<string>();
	for (const raw of commits) {
		const commit = obj(raw);
		for (const file of [...strings(commit.added), ...strings(commit.modified)]) {
			all.add(file);
			addedOrModified.add(file);
		}
		for (const file of strings(commit.removed)) all.add(file);
	}
	return { all: [...all], addedOrModified: [...addedOrModified] };
}

/**
 * GitHub-shaped push (GitHub, Gitea, Forgejo). GitHub lists at most 20 commits; Gitea and Forgejo
 * say how many there were in `total_commits`. Beyond that the file list is unknown (null), so path
 * filters never wrongly skip a workflow.
 */
function githubLikePush(payload: Json): ForgePushEvent | { kind: 'ignored'; reason: string } {
	const ref = str(payload.ref);
	if (!ref) return { kind: 'ignored', reason: 'push without a ref' };
	const afterRaw = str(payload.after);
	const deleted = payload.deleted === true || !afterRaw || ZERO_SHA.test(afterRaw);
	const commits = arr(payload.commits);
	const total = typeof payload.total_commits === 'number' ? payload.total_commits : null;
	const complete = commits.length > 0 && (total !== null ? total <= commits.length : commits.length < 20);
	const files = fileLists(commits);
	const repository = obj(payload.repository);
	const pusher = obj(payload.pusher);
	const sender = obj(payload.sender);
	return {
		kind: 'push',
		ref,
		after: deleted ? null : afterRaw,
		deleted,
		changedFiles: complete ? files.all : null,
		addedOrModified: files.addedOrModified,
		message: str(obj(payload.head_commit).message),
		actor: str(pusher.name) ?? str(pusher.login) ?? str(pusher.username) ?? str(sender.login),
		fullName: str(repository.full_name),
		cloneUrl: str(repository.clone_url),
		defaultBranch: str(repository.default_branch),
	};
}

/** Gitea and Forgejo name a few actions differently from GitHub. */
const GITEA_ACTIONS: Record<string, string> = { synchronized: 'synchronize', label_updated: 'labeled', label_cleared: 'labeled' };

function githubLikePullRequest(payload: Json, source: WebhookSource): ForgeEvent {
	const pr = obj(payload.pull_request);
	const head = obj(pr.head);
	const base = obj(pr.base);
	const number = typeof payload.number === 'number' ? payload.number : typeof pr.number === 'number' ? pr.number : null;
	const headSha = str(head.sha);
	if (!number || !headSha) return { kind: 'ignored', reason: 'not a pull request' };
	const action = str(payload.action) ?? '';
	const headRepo = str(obj(head.repo).full_name);
	const baseRepo = str(obj(base.repo).full_name);
	return {
		kind: 'pull_request',
		action: source === 'github' ? action : (GITEA_ACTIONS[action] ?? action),
		number,
		title: str(pr.title),
		headSha,
		headRef: str(head.ref),
		baseRef: str(base.ref),
		sameRepository: Boolean(headRepo && baseRepo && headRepo === baseRepo),
		fetchRef: `refs/pull/${number}/head`,
		actor: str(obj(payload.sender).login),
		fullName: baseRepo ?? str(obj(payload.repository).full_name),
	};
}

function gitlabPush(payload: Json): ForgeEvent {
	const ref = str(payload.ref);
	if (!ref) return { kind: 'ignored', reason: 'push without a ref' };
	const afterRaw = str(payload.after) ?? str(payload.checkout_sha);
	const deleted = !afterRaw || ZERO_SHA.test(afterRaw);
	const commits = arr(payload.commits);
	const total = typeof payload.total_commits_count === 'number' ? payload.total_commits_count : commits.length;
	// GitLab lists at most 20 commits, oldest first, and says how many there were.
	const complete = commits.length > 0 && total <= commits.length;
	const files = fileLists(commits);
	const head = commits.map(obj).find((commit) => commit.id === afterRaw) ?? obj(commits[commits.length - 1]);
	const project = obj(payload.project);
	return {
		kind: 'push',
		ref,
		after: deleted ? null : afterRaw,
		deleted,
		changedFiles: complete ? files.all : null,
		addedOrModified: files.addedOrModified,
		message: str(head.message),
		actor: str(payload.user_username) ?? str(payload.user_name),
		fullName: str(project.path_with_namespace),
		cloneUrl: str(project.git_http_url) ?? str(project.http_url),
		defaultBranch: str(project.default_branch),
	};
}

function gitlabMergeRequest(payload: Json): ForgeEvent {
	const attributes = obj(payload.object_attributes);
	const iid = typeof attributes.iid === 'number' ? attributes.iid : null;
	const headSha = str(obj(attributes.last_commit).id);
	if (!iid || !headSha) return { kind: 'ignored', reason: 'not a merge request' };
	const raw = str(attributes.action) ?? '';
	const changes = obj(payload.changes);
	let action = raw;
	if (raw === 'open') action = 'opened';
	else if (raw === 'reopen') action = 'reopened';
	else if (raw === 'update') {
		const draft = obj(changes.draft ?? changes.work_in_progress);
		if (str(attributes.oldrev)) action = 'synchronize';
		else if (draft.previous === true && draft.current === false) action = 'ready_for_review';
		else if (changes.labels) action = 'labeled';
		else action = 'edited';
	}
	const project = obj(payload.project);
	return {
		kind: 'pull_request',
		action,
		number: iid,
		title: str(attributes.title),
		headSha,
		headRef: str(attributes.source_branch),
		baseRef: str(attributes.target_branch),
		sameRepository:
			attributes.source_project_id !== undefined && attributes.source_project_id === attributes.target_project_id,
		fetchRef: `refs/merge-requests/${iid}/head`,
		actor: str(obj(payload.user).username),
		fullName: str(project.path_with_namespace) ?? str(obj(attributes.target).path_with_namespace),
	};
}

/**
 * One delivery → a `ForgeEvent`. `event` is the header value (`push`, `pull_request`,
 * `Push Hook`, …); GitLab payloads are recognised by `object_kind` whatever the header says.
 */
export function normaliseForgeEvent(source: WebhookSource, event: string | null, payload: unknown): ForgeEvent {
	const body = obj(payload);
	if (source === 'gitlab') {
		const kind = str(body.object_kind) ?? str(body.event_name);
		if (kind === 'push' || kind === 'tag_push') return gitlabPush(body);
		if (kind === 'merge_request') return gitlabMergeRequest(body);
		return { kind: 'ignored', reason: `GitLab event ${kind ?? event ?? '(none)'} is not handled` };
	}
	if (event === 'ping') return { kind: 'ping' };
	if (event === 'push') return githubLikePush(body);
	// Gitea and Forgejo send label, assignment and sync changes as `pull_request` too.
	if (event === 'pull_request' || (source !== 'github' && event?.startsWith('pull_request') && body.pull_request && !body.review && !body.comment))
		return githubLikePullRequest(body, source);
	return { kind: 'ignored', reason: `event ${event ?? '(none)'} is not handled` };
}

/** `refs/heads/main` → `main`; null for tags and other refs. */
export function pushedBranch(event: ForgePushEvent): string | null {
	return event.ref.startsWith('refs/heads/') ? event.ref.slice('refs/heads/'.length) : null;
}
