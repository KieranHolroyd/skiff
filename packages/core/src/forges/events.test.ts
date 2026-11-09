import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { forgeFullName, parseRepoUrl, repoKey } from '@yoal/contracts';
import { normaliseForgeEvent, verifyDelivery, webhookEventName, webhookSource, type HeaderReader } from './events.ts';

const headers = (values: Record<string, string>): HeaderReader => ({ get: (name) => values[name.toLowerCase()] ?? null });
const hex = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

describe('repository URLs', () => {
	test('parse every common form, nested paths included', () => {
		expect(parseRepoUrl('https://gitlab.com/acme/platform/api.git')).toEqual({ host: 'gitlab.com', path: 'acme/platform/api' });
		expect(parseRepoUrl('git@gitlab.com:acme/api.git')).toEqual({ host: 'gitlab.com', path: 'acme/api' });
		expect(parseRepoUrl('ssh://git@git.example.com:2222/acme/api.git')).toEqual({ host: 'git.example.com', path: 'acme/api' });
		expect(parseRepoUrl('https://git.example.com:8443/gitea/acme/api')).toEqual({ host: 'git.example.com:8443', path: 'gitea/acme/api' });
		expect(parseRepoUrl('https://gitlab.com/onlyone')).toBeNull();
		expect(parseRepoUrl('/srv/git/app')).toBeNull();
		expect(repoKey('https://GitLab.com/Acme/API.git')).toBe('gitlab.com/acme/api');
	});

	test('full names are relative to a connection, honouring a base path', () => {
		expect(forgeFullName('https://gitlab.com', 'https://gitlab.com/acme/platform/api.git')).toBe('acme/platform/api');
		expect(forgeFullName('https://gitlab.com', 'git@gitlab.com:acme/api.git')).toBe('acme/api');
		expect(forgeFullName('https://git.example.com/gitea', 'https://git.example.com/gitea/acme/api.git')).toBe('acme/api');
		expect(forgeFullName('https://git.example.com/gitea', 'https://git.example.com/other/acme/api.git')).toBeNull();
		expect(forgeFullName('https://git.example.com/gitea', 'git@git.example.com:acme/api.git')).toBe('acme/api');
		expect(forgeFullName('https://codeberg.org', 'https://gitlab.com/acme/api.git')).toBeNull();
	});
});

describe('webhook verification', () => {
	const body = '{"a":1}';
	test('GitLab compares the token in constant time', () => {
		expect(webhookSource(headers({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 's3cret' }))).toBe('gitlab');
		expect(verifyDelivery('gitlab', 's3cret', body, headers({ 'x-gitlab-token': 's3cret' }))).toBe(true);
		expect(verifyDelivery('gitlab', 's3cret', body, headers({ 'x-gitlab-token': 'wrong!' }))).toBe(false);
		expect(verifyDelivery('gitlab', 's3cret', body, headers({}))).toBe(false);
	});

	test('Gitea and Forgejo sign the body (and also send GitHub’s header)', () => {
		const forgejo = headers({ 'x-forgejo-event': 'push', 'x-gitea-event': 'push', 'x-github-event': 'push', 'x-forgejo-signature': hex('k', body) });
		expect(webhookSource(forgejo)).toBe('forgejo');
		expect(webhookEventName('forgejo', forgejo)).toBe('push');
		expect(verifyDelivery('forgejo', 'k', body, forgejo)).toBe(true);
		expect(verifyDelivery('gitea', 'k', body, headers({ 'x-gitea-signature': hex('other', body) }))).toBe(false);
		expect(verifyDelivery('gitea', 'k', body, headers({ 'x-hub-signature-256': `sha256=${hex('k', body)}` }))).toBe(true);
	});

	test('GitHub needs X-Hub-Signature-256', () => {
		expect(verifyDelivery('github', 'k', body, headers({ 'x-hub-signature-256': `sha256=${hex('k', body)}` }))).toBe(true);
		expect(verifyDelivery('github', 'k', body, headers({ 'x-gitea-signature': hex('k', body) }))).toBe(false);
	});
});

describe('normalised events', () => {
	test('a GitHub push with a short commit list keeps its files', () => {
		const event = normaliseForgeEvent('github', 'push', {
			ref: 'refs/heads/main',
			after: 'a'.repeat(40),
			commits: [{ added: ['x'], modified: ['.yoal/workflows/ci.yml'], removed: ['y'] }],
			head_commit: { message: 'ship' },
			pusher: { name: 'kim' },
			repository: { full_name: 'acme/app', clone_url: 'https://github.com/acme/app.git', default_branch: 'main' },
		});
		expect(event).toMatchObject({
			kind: 'push',
			after: 'a'.repeat(40),
			deleted: false,
			changedFiles: ['x', '.yoal/workflows/ci.yml', 'y'],
			addedOrModified: ['x', '.yoal/workflows/ci.yml'],
			message: 'ship',
			actor: 'kim',
			fullName: 'acme/app',
		});
	});

	test('a deleted branch has no head', () => {
		expect(normaliseForgeEvent('github', 'push', { ref: 'refs/heads/x', after: '0'.repeat(40), deleted: true })).toMatchObject({ deleted: true, after: null });
	});

	test('a Gitea push with more commits than listed has unknown files', () => {
		const event = normaliseForgeEvent('gitea', 'push', {
			ref: 'refs/heads/main',
			after: 'b'.repeat(40),
			total_commits: 30,
			commits: [{ added: ['a'] }],
			pusher: { login: 'ana' },
			repository: { full_name: 'acme/app', clone_url: 'https://codeberg.org/acme/app.git' },
		});
		expect(event).toMatchObject({ kind: 'push', changedFiles: null, actor: 'ana', cloneUrl: 'https://codeberg.org/acme/app.git' });
	});

	test('Gitea pull request actions use GitHub’s names; a fork is not the same repository', () => {
		const event = normaliseForgeEvent('forgejo', 'pull_request', {
			action: 'synchronized',
			number: 4,
			pull_request: { title: 'T', head: { sha: 'c'.repeat(40), ref: 'feat', repo: { full_name: 'evil/app' } }, base: { ref: 'main', repo: { full_name: 'acme/app' } } },
			sender: { login: 'eve' },
		});
		expect(event).toMatchObject({ kind: 'pull_request', action: 'synchronize', number: 4, sameRepository: false, fetchRef: 'refs/pull/4/head', fullName: 'acme/app' });
		expect(normaliseForgeEvent('gitea', 'pull_request_comment', { pull_request: {}, comment: {} }).kind).toBe('ignored');
	});

	test('GitLab pushes find the head commit and count truncated lists', () => {
		const event = normaliseForgeEvent('gitlab', 'Push Hook', {
			object_kind: 'push',
			ref: 'refs/heads/main',
			after: 'd'.repeat(40),
			total_commits_count: 2,
			commits: [
				{ id: 'e'.repeat(40), message: 'older', added: ['a'] },
				{ id: 'd'.repeat(40), message: 'newest', modified: ['b'] },
			],
			user_username: 'gl-user',
			project: { path_with_namespace: 'acme/platform/api', git_http_url: 'https://gitlab.com/acme/platform/api.git', default_branch: 'main' },
		});
		expect(event).toMatchObject({ kind: 'push', message: 'newest', changedFiles: ['a', 'b'], actor: 'gl-user', fullName: 'acme/platform/api' });
		const truncated = normaliseForgeEvent('gitlab', 'Push Hook', { object_kind: 'push', ref: 'refs/heads/main', after: 'd'.repeat(40), total_commits_count: 25, commits: [{ id: 'd'.repeat(40) }], project: {} });
		expect(truncated).toMatchObject({ changedFiles: null });
	});

	test('GitLab merge requests map actions, refs and forks', () => {
		const base = {
			object_kind: 'merge_request',
			user: { username: 'dev' },
			project: { path_with_namespace: 'acme/api' },
		};
		const attributes = { iid: 9, title: 'MR', source_branch: 'feat', target_branch: 'main', last_commit: { id: 'f'.repeat(40) }, source_project_id: 1, target_project_id: 1 };
		expect(normaliseForgeEvent('gitlab', 'Merge Request Hook', { ...base, object_attributes: { ...attributes, action: 'open' } })).toMatchObject({
			kind: 'pull_request',
			action: 'opened',
			number: 9,
			sameRepository: true,
			fetchRef: 'refs/merge-requests/9/head',
			headRef: 'feat',
			baseRef: 'main',
			actor: 'dev',
		});
		expect(normaliseForgeEvent('gitlab', null, { ...base, object_attributes: { ...attributes, action: 'update', oldrev: '1'.repeat(40) } })).toMatchObject({ action: 'synchronize' });
		expect(normaliseForgeEvent('gitlab', null, { ...base, object_attributes: { ...attributes, action: 'update' }, changes: { draft: { previous: true, current: false } } })).toMatchObject({
			action: 'ready_for_review',
		});
		expect(normaliseForgeEvent('gitlab', null, { ...base, object_attributes: { ...attributes, action: 'open', source_project_id: 2 } })).toMatchObject({ sameRepository: false });
		expect(normaliseForgeEvent('gitlab', 'Note Hook', { object_kind: 'note' }).kind).toBe('ignored');
	});
});
