<script lang="ts">
	/** The actions menu entries for a rule: edit, pause/resume, evaluate, test, duplicate, delete. */
	import type { AlertRuleSummary } from '@skiff/contracts';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import type { ruleActions } from './rule-actions.js';

	let {
		rule,
		actions,
		onedit,
		ondeleted,
		showEdit = true
	}: {
		rule: AlertRuleSummary;
		actions: ReturnType<typeof ruleActions>;
		onedit: () => void;
		ondeleted?: () => void;
		showEdit?: boolean;
	} = $props();
</script>

{#if rule.canEdit && showEdit}
	<DropdownMenu.Item onSelect={onedit}><PencilIcon />Edit</DropdownMenu.Item>
{/if}
{#if rule.canEdit}
	<DropdownMenu.Item onSelect={() => actions.setEnabled(rule, !rule.enabled)}>
		{#if rule.enabled}<PauseIcon />Pause{:else}<PlayIcon />Resume{/if}
	</DropdownMenu.Item>
{/if}
{#if rule.canEdit}
	<DropdownMenu.Item disabled={!rule.enabled} onSelect={() => actions.evaluate(rule)}
		><RefreshCwIcon />Evaluate now</DropdownMenu.Item
	>
	<DropdownMenu.Item onSelect={() => actions.sendTest(rule)}
		><SendIcon />Send test</DropdownMenu.Item
	>
	<DropdownMenu.Item onSelect={() => actions.duplicate(rule)}
		><CopyIcon />Duplicate</DropdownMenu.Item
	>
	<DropdownMenu.Separator />
	<DropdownMenu.Item variant="destructive" onSelect={() => actions.remove(rule, ondeleted)}
		><Trash2Icon />Delete</DropdownMenu.Item
	>
{/if}
