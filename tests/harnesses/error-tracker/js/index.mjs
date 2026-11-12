/**
 * JavaScript harness: real @sentry/node against the Yoal app error tracker.
 *
 * Every scenario is intentionally stable (same message, same frames) so running the harness twice
 * checks grouping: the second run should add to the same issue, not create a new one.
 *
 * The `sk_test_fake_secret_123456` extra is deliberate. It is fake, and it exists to prove the
 * tracker scrubs it before storage. Do not put a real credential in a harness.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.ERROR_TRACKER_DSN ?? process.env.SENTRY_DSN;
if (!dsn) {
	console.error('ERROR_TRACKER_DSN (or SENTRY_DSN) is required');
	process.exit(2);
}

const lang = 'js';
const release = process.env.HARNESS_RELEASE ?? `${lang}-harness@1.0.0`;
const environment = process.env.HARNESS_ENV ?? 'harness';

Sentry.init({
	dsn,
	release,
	environment,
	tracesSampleRate: 1.0,
	sendDefaultPii: false,
	debug: process.env.HARNESS_DEBUG === '1',
	initialScope: {
		tags: { lang, harness: 'error-tracker' },
	},
});

/** @type {Array<{ label: string, eventId: string | undefined }>} */
const sent = [];

/**
 * @param {string} label
 * @param {() => string | undefined} run
 */
function capture(label, run) {
	const eventId = run();
	sent.push({ label, eventId });
	console.log(`sent ${label} event_id=${eventId ?? '-'}`);
}

// 1. The simplest exception.
capture('simple', () => Sentry.captureException(new Error('js-harness: simple failure')));

// 2. A wrapper with a cause, to check exception chains.
const root = new Error('js-harness: root cause');
const wrapper = new Error('js-harness: wrapper failure', { cause: root });
capture('chained', () => Sentry.captureException(wrapper));

// 3. A message event with no exception.
capture('message', () => Sentry.captureMessage('js-harness: warning message', 'warning'));

// 4. Tags, user and extra context on a scoped event.
capture('tags', () =>
	Sentry.withScope((scope) => {
		scope.setTag('scenario', 'tags');
		scope.setUser({ id: 'user_123' });
		scope.setExtra('orderId', 42);
		scope.setExtra('token', 'sk_test_fake_secret_123456');
		return Sentry.captureException(new Error('js-harness: scoped failure'));
	}),
);

// 5. Values that must be masked before they reach the fingerprint.
capture('normalize', () =>
	Sentry.captureException(
		new Error('js-harness: order 12345 failed for user 550e8400-e29b-41d4-a716-446655440000 after 3 tries'),
	),
);

// 6. Telemetry the tracker must accept and discard. With tracing on, this sends a transaction.
Sentry.startSpan({ name: 'js-harness-transaction', op: 'harness' }, () => {
	// Empty on purpose: the point is the transaction envelope, not the work.
});
console.log('sent telemetry transaction');

const flushed = await Sentry.flush(5_000);
Sentry.close();

if (!flushed) {
	console.error('Sentry.flush() returned false: the event(s) may not have reached the tracker');
	process.exit(1);
}

console.log(JSON.stringify({ lang, release, environment, sent, flushed }));
