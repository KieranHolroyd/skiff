/**
 * A small in-process rate limit for assistant turns. The assistant is optional and expensive
 * (several model calls per turn), so a single signed-in user cannot drain a provider quota or a
 * local GPU by holding the send button.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const buckets = new Map<string, number[]>();

export function allowAssistantTurn(key: string): { ok: true } | { ok: false; retryAfter: number } {
	const now = Date.now();
	const recent = (buckets.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	if (recent.length >= MAX_PER_WINDOW) {
		const oldest = recent[0] ?? now;
		return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)) };
	}
	recent.push(now);
	buckets.set(key, recent);
	if (buckets.size > 5_000) {
		for (const [id, times] of buckets)
			if (times.every((at) => now - at >= WINDOW_MS)) buckets.delete(id);
	}
	return { ok: true };
}
