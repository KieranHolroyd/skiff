import type { ServerErrorSource, ServerErrorStatus } from '@yoal/contracts';
import type { Tone } from '#lib/status.js';

export const statusLabel: Record<ServerErrorStatus, string> = {
	unresolved: 'Unresolved',
	resolved: 'Resolved',
	ignored: 'Ignored'
};

export const statusTone: Record<ServerErrorStatus, Tone> = {
	unresolved: 'danger',
	resolved: 'success',
	ignored: 'neutral'
};

export { serverErrorSourceLabels as sourceLabel } from '@yoal/contracts';

export const sourceDescription: Record<ServerErrorSource, string> = {
	request: 'Thrown in a dashboard page load, form action or endpoint.',
	api: 'Thrown in a REST API handler that answered 500.',
	response: 'A 5xx the control plane answered without an exception it saw.',
	background: 'Thrown in a background loop (maintenance, failover, jobs, flows, drains).'
};
