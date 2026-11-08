/**
 * GitHub commit statuses for pipeline runs (docs/PIPELINES.md WP3). A repository may store a
 * GitHub token allowed to write commit statuses; every run then reports `pending` when it is
 * created and `success`/`failure`/`error` when it completes, under the context
 * `skiff/<workflow name>`, linking to the run page. Reporting is best-effort: a failure is logged
 * and never affects the run.
 */

export interface CommitStatusTarget {
	owner: string;
	repo: string;
}

/** `https://github.com/acme/app(.git)` or `git@github.com:acme/app.git` → `{owner, repo}`. */
export function githubTarget(cloneUrl: string): CommitStatusTarget | null {
	const match =
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(cloneUrl) ??
		/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(cloneUrl);
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

/** Run status/conclusion → GitHub commit state. Skipped runs report success (nothing failed). */
export function commitState(status: string, conclusion: string | null): CommitState {
	if (status !== 'completed') return 'pending';
	if (conclusion === 'success' || conclusion === 'skipped') return 'success';
	if (conclusion === 'failure' || conclusion === 'timed_out') return 'failure';
	return 'error';
}

export interface CommitStatusInput {
	token: string;
	target: CommitStatusTarget;
	sha: string;
	state: CommitState;
	context: string;
	description: string;
	targetUrl: string;
	apiBase?: string;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export async function postCommitStatus(input: CommitStatusInput): Promise<void> {
	const base = (input.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
	const doFetch = input.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
	const response = await doFetch(
		`${base}/repos/${encodeURIComponent(input.target.owner)}/${encodeURIComponent(input.target.repo)}/statuses/${input.sha}`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${input.token}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28',
				'content-type': 'application/json',
				'user-agent': 'skiff-pipelines',
			},
			body: JSON.stringify({
				state: input.state,
				context: input.context.slice(0, 255),
				description: input.description.slice(0, 140),
				target_url: input.targetUrl,
			}),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
}
