import type { AlertRuleSummary, AlertRuleView } from '@skiff/contracts';
import type { QueryClient } from '@tanstack/svelte-query';
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { errorText } from '#lib/query.js';
import { confirmAction } from '../../dashboards/_lib/ConfirmDialog.svelte';
import { deleteRule, evaluateRule, keys, testRule, updateRule } from './api.js';

/**
 * Rule actions shared by the rules table and a rule's page: pause/resume, evaluate now, send a
 * test notification, duplicate (opens the editor) and delete (confirmed). Each refreshes the
 * alerts queries and reports through a toast.
 */
export function ruleActions(queryClient: QueryClient) {
	const store = (rule: AlertRuleView) => {
		queryClient.setQueryData(keys.rule(rule.id), rule);
		void queryClient.invalidateQueries({ queryKey: keys.all });
	};

	async function setEnabled(rule: AlertRuleSummary, enabled: boolean): Promise<void> {
		try {
			store(await updateRule(rule.id, { version: rule.version, enabled }));
			toast.success(enabled ? `Resumed “${rule.name}”` : `Paused “${rule.name}”`);
		} catch (error) {
			toast.error(errorText(error, 'Could not update the rule.'));
			void queryClient.invalidateQueries({ queryKey: keys.all });
		}
	}

	async function evaluate(rule: AlertRuleSummary): Promise<void> {
		try {
			const next = await evaluateRule(rule.id);
			store(next);
			if (next.health === 'error') toast.error(next.lastError ?? 'The rule failed to evaluate.');
			else {
				const alerting = next.counts.firing + next.counts.nodata;
				toast.success(
					alerting
						? `Evaluated: ${alerting} series alerting`
						: next.counts.pending
							? `Evaluated: ${next.counts.pending} pending`
							: 'Evaluated: all clear'
				);
			}
		} catch (error) {
			toast.error(errorText(error, 'Could not evaluate the rule.'));
		}
	}

	async function sendTest(rule: AlertRuleSummary): Promise<void> {
		try {
			const delivery = await testRule(rule.id);
			const entries = Object.entries(delivery);
			const failed = entries.filter(([, outcome]) => outcome !== 'ok');
			if (entries.length === 0)
				toast.warning('No channels to send to: configure notifications first.');
			else if (failed.length === 0)
				toast.success(`Test sent to ${entries.map(([channel]) => channel).join(', ')}`);
			else
				toast.error(
					`Test failed for ${failed.map(([channel, outcome]) => `${channel} (${outcome})`).join(', ')}`
				);
			void queryClient.invalidateQueries({ queryKey: keys.all });
		} catch (error) {
			toast.error(errorText(error, 'Could not send a test notification.'));
		}
	}

	function duplicate(rule: AlertRuleSummary): void {
		const href = `${resolve('/(dashboard)/alerts/rules/new')}?duplicate=${encodeURIComponent(rule.id)}`;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus `?duplicate`
		void goto(href);
	}

	function remove(rule: AlertRuleSummary, after?: () => void): void {
		confirmAction({
			title: `Delete “${rule.name}”?`,
			description:
				'The rule, its series, and silences scoped to it are deleted. Firing alerts are cleared without a resolve notification. History is kept.',
			confirmLabel: 'Delete rule',
			tone: 'danger',
			run: async () => {
				await deleteRule(rule.id);
				queryClient.setQueryData<AlertRuleSummary[]>(keys.rules, (current) =>
					current?.filter((item) => item.id !== rule.id)
				);
				queryClient.removeQueries({ queryKey: keys.rule(rule.id) });
				void queryClient.invalidateQueries({ queryKey: keys.all });
				toast.success('Rule deleted');
				after?.();
			}
		});
	}

	return { setEnabled, evaluate, sendTest, duplicate, remove };
}
