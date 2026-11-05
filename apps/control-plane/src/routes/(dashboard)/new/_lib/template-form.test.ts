import { describe, expect, it } from 'bun:test';
import { githubRunnerTemplate } from '@skiff/contracts';
import {
	apiSnippet,
	collectValues,
	effectiveSlug,
	formGroups,
	formatMb,
	initialState,
	isOffered,
	isVisible,
	predictAuto,
	validate
} from './template-form.js';

const template = githubRunnerTemplate;
const field = (key: string) => template.fields.find((candidate) => candidate.key === key)!;

function filled() {
	const state = initialState(template);
	state.values.name = 'CI runners';
	state.values.owner = 'acme';
	state.values.repo = 'api';
	state.values.token = 'github_pat_secret';
	return state;
}

describe('template form', () => {
	it('groups fields in the declared order with advanced last', () => {
		const groups = formGroups(template);
		expect(groups.map((group) => group.id)).toEqual([
			'project',
			'github',
			'credential',
			'capacity',
			'advanced'
		]);
		expect(groups.flatMap((group) => group.fields).length).toBe(template.fields.length);
	});

	it('puts ungrouped fields in a default group before advanced ones', () => {
		const groups = formGroups({
			...template,
			fields: template.fields.map((item) =>
				item.key === 'owner' ? { ...item, group: undefined } : item
			)
		});
		expect(groups.map((group) => group.id)).toEqual([
			'project',
			'github',
			'credential',
			'capacity',
			'configuration',
			'advanced'
		]);
	});

	it('starts from field defaults', () => {
		const state = initialState(template);
		expect(state.values.replicas).toBe('2');
		expect(state.values.scope).toBe('repo');
		expect(state.placement).toBe('auto');
	});

	it('follows showWhen and swaps replaced fields for their alternative', () => {
		const state = filled();
		expect(isVisible(template, field('repo'), state)).toBe(true);
		expect(isVisible(template, field('runnerGroupId'), state)).toBe(false);
		expect(isVisible(template, field('existingSecret'), state)).toBe(false);
		expect(isOffered(template, field('existingSecret'), state)).toBe(true);

		state.alternatives.existingSecret = true;
		expect(isVisible(template, field('token'), state)).toBe(false);
		expect(isVisible(template, field('existingSecret'), state)).toBe(true);
	});

	it('submits only visible, non-empty values', () => {
		const state = filled();
		state.values.existingSecret = 'LEFT_OVER';
		const values = collectValues(template, state);
		expect(values.token).toBe('github_pat_secret');
		expect(values.existingSecret).toBeUndefined();
		expect(values.runnerGroupId).toBeUndefined();
		expect(values.placement).toBe('auto');
	});

	it('derives the slug from the name and suffixes new secrets with it', () => {
		const state = filled();
		expect(effectiveSlug(template, state)).toBe('ci-runners');
		const result = validate(template, state);
		expect(result.issues).toEqual({});
		expect(result.plan?.secrets.map((secret) => secret.name)).toEqual([
			'GITHUB_RUNNER_TOKEN_CI_RUNNERS'
		]);
		expect(result.plan?.spec.replicas).toBe(2);
	});

	it('marks every empty required field that is shown, before the schema gets that far', () => {
		const result = validate(template, initialState(template));
		expect(result.plan).toBeNull();
		expect(Object.keys(result.issues).sort()).toEqual(['name', 'owner', 'repo', 'token']);
		expect(result.issues.repo).toBe('Required.');

		const org = initialState(template);
		org.values.scope = 'org';
		org.values.auth = 'app';
		expect(Object.keys(validate(template, org).issues).sort()).toEqual([
			'appId',
			'installationId',
			'name',
			'owner',
			'privateKey'
		]);
	});

	it('moves a credential problem onto the alternative field in use', () => {
		const state = filled();
		state.alternatives.existingSecret = true;
		const result = validate(template, state);
		expect(result.issues.existingSecret).toBeDefined();
		expect(result.issues.token).toBeUndefined();

		state.values.existingSecret = 'ACME_RUNNER_PAT';
		const ok = validate(template, state);
		expect(ok.plan?.requiredSecrets).toEqual(['ACME_RUNNER_PAT']);
		expect(ok.plan?.secrets).toEqual([]);
	});

	it('keeps credentials out of the API snippet', () => {
		const snippet = apiSnippet(template, filled(), 'https://skiff.example.com');
		expect(snippet).toContain('/api/v1/templates/github-actions-runner');
		expect(snippet).toContain('"replicas":2');
		expect(snippet).not.toContain('github_pat_secret');
	});

	it('formats memory', () => {
		expect(formatMb(512)).toBe('512 MB');
		expect(formatMb(2048)).toBe('2 GB');
		expect(formatMb(1536)).toBe('1.5 GB');
	});
});

describe('auto placement preview', () => {
	const nodes = [
		{ nodeId: 'e', name: 'edge', mode: 'edge', status: 'online', freeMemoryMb: 8000 },
		{ nodeId: 'a', name: 'alpha', mode: 'worker', status: 'online', freeMemoryMb: 3000 },
		{ nodeId: 'b', name: 'bravo', mode: 'worker', status: 'online', freeMemoryMb: 6000 },
		{ nodeId: 'c', name: 'charlie', mode: 'worker', status: 'draining', freeMemoryMb: 9000 }
	];

	it('prefers the online worker with the most room', () => {
		expect(predictAuto(nodes, 2048)?.name).toBe('bravo');
	});

	it('falls back to the edge, then to nothing', () => {
		expect(predictAuto(nodes, 7000)?.name).toBe('edge');
		expect(predictAuto(nodes, 9000)).toBeNull();
	});
});
