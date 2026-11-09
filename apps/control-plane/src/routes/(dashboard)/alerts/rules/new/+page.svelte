<script lang="ts">
	/**
	 * A new alert rule: blank, `?template=<id>` (an outage preset), `?duplicate=<rule id>`, or
	 * `?draft=1` (a draft handed over in session storage, e.g. "Create alert…" on a dashboard
	 * panel).
	 */
	import { alertRuleTemplate, type AlertRuleInput, type AlertRuleView } from '@yoal/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { errorText } from '#lib/query.js';
	import PageHeader from '../../../_lib/PageHeader.svelte';
	import { createSchemaQuery } from '../../../dashboards/_lib/panel-query.svelte.js';
	import AlertsNotices from '../../_lib/AlertsNotices.svelte';
	import { getOverview, getRule, keys } from '../../_lib/api.js';
	import RuleEditor from '../../_lib/RuleEditor.svelte';
	import { DRAFT_KEY, ruleDraft, specOf } from '../../_lib/rules.js';

	const queryClient = useQueryClient();
	const params = page.url.searchParams;
	const template = alertRuleTemplate(params.get('template') ?? '');
	const duplicateId = params.get('duplicate');

	/** A draft from a dashboard panel, read once. */
	function readDraft(): AlertRuleInput | null {
		if (!browser || params.get('draft') !== '1') return null;
		try {
			const raw = sessionStorage.getItem(DRAFT_KEY);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			return parsed && typeof parsed === 'object' ? (parsed as AlertRuleInput) : null;
		} catch {
			return null;
		}
	}
	const draft = readDraft();

	const overviewQuery = createQuery(() => ({
		queryKey: keys.overview,
		queryFn: ({ signal }) => getOverview(signal)
	}));
	const schemaQuery = createSchemaQuery();
	const sourceQuery = createQuery(() => ({
		queryKey: keys.rule(duplicateId ?? ''),
		queryFn: ({ signal }) => getRule(duplicateId!, signal),
		enabled: browser && duplicateId !== null
	}));

	const ready = $derived(
		!overviewQuery.isPending &&
			!schemaQuery.isPending &&
			(duplicateId === null || !sourceQuery.isPending)
	);

	const initial = $derived.by(() => {
		if (duplicateId && sourceQuery.data) {
			const spec = specOf(sourceQuery.data);
			return ruleDraft({ ...spec, name: `${spec.name} (copy)`.slice(0, 120) });
		}
		if (template) return ruleDraft(template.rule);
		if (draft) return ruleDraft(draft);
		return ruleDraft(undefined);
	});

	const heading = $derived(
		duplicateId
			? 'Duplicate alert rule'
			: template
				? `New rule: ${template.title}`
				: draft
					? 'New alert from a panel'
					: 'New alert rule'
	);
	const description = $derived(
		template?.description ??
			(draft
				? 'Prefilled from the panel’s query, its first metric and the dashboard’s current variable values. Set a threshold and save.'
				: 'A rule checks one metric per series on a schedule and notifies your channels when it crosses a threshold.')
	);

	function saved(rule: AlertRuleView) {
		queryClient.setQueryData(keys.rule(rule.id), rule);
		void queryClient.invalidateQueries({ queryKey: keys.all });
		if (draft && browser) sessionStorage.removeItem(DRAFT_KEY);
		void goto(resolve('/(dashboard)/alerts/rules/[id]', { id: rule.id }), { replaceState: true });
	}

	function cancel() {
		if (history.length > 1) history.back();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?tab`
		else void goto(`${resolve('/(dashboard)/alerts')}?tab=rules`);
	}
</script>

<svelte:head><title>{heading} · Alerts · Yoal</title></svelte:head>

<div class="space-y-6">
	<PageHeader title={heading} {description} />

	<AlertsNotices overview={overviewQuery.data} schema={schemaQuery.data} />

	{#if !ready}
		<div class="space-y-4">
			<Skeleton class="h-48" /><Skeleton class="h-72" /><Skeleton class="h-40" />
		</div>
	{:else if overviewQuery.error}
		<Notice tone="danger" title="Could not load alerts">{errorText(overviewQuery.error)}</Notice>
	{:else if duplicateId && sourceQuery.error}
		<Notice tone="danger" title="Could not load the rule to duplicate"
			>{errorText(sourceQuery.error)}</Notice
		>
	{:else}
		<RuleEditor
			{initial}
			overview={overviewQuery.data}
			schema={schemaQuery.data}
			oncancel={cancel}
			onsaved={saved}
		/>
	{/if}
</div>
