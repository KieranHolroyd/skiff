<script lang="ts">
	/** A rule's severity, as a quiet outlined badge with a coloured marker. */
	import type { AlertSeverity } from '@yoal/contracts';
	import { Badge } from '#lib/components/ui/badge/index.js';

	let { severity }: { severity: AlertSeverity } = $props();

	const DOT: Record<AlertSeverity, string> = {
		critical: 'bg-destructive',
		warning: 'bg-warning',
		info: 'bg-info'
	};
</script>

<Badge variant="outline" class="font-normal capitalize">
	<span class="size-1.5 rounded-full {DOT[severity]}" aria-hidden="true"></span>{severity}
</Badge>
