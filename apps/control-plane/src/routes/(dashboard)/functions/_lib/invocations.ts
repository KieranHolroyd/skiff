/**
 * workerd's tail outcomes (`ok`, `exception`, `exceededCpu`, `exceededMemory`, `canceled`,
 * `scriptNotFound`, `responseStreamDisconnected`, `unknown`) mapped onto badge tones.
 */
export function outcomeTone(outcome: string): 'success' | 'danger' | 'warning' | 'neutral' {
	if (outcome === 'ok') return 'success';
	if (outcome === 'exception' || outcome === 'scriptNotFound') return 'danger';
	if (outcome.startsWith('exceeded') || outcome === 'canceled') return 'warning';
	return 'neutral';
}

/** Share of invocations that did not end `ok`, 0–1; null when nothing ran. */
export function invocationErrorRate(byOutcome: Record<string, number>): number | null {
	let total = 0;
	let ok = 0;
	for (const [outcome, count] of Object.entries(byOutcome)) {
		total += count;
		if (outcome === 'ok') ok += count;
	}
	return total > 0 ? (total - ok) / total : null;
}
