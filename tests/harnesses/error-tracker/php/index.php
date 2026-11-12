<?php

/**
 * PHP harness: real sentry/sentry against the Yoal app error tracker.
 *
 * Every scenario is stable so running the harness twice checks grouping. The fake
 * `sk_test_fake_secret_123456` extra proves the tracker scrubs it before storage.
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

$dsn = getenv('ERROR_TRACKER_DSN') ?: getenv('SENTRY_DSN');
if (!$dsn) {
    fwrite(STDERR, "ERROR_TRACKER_DSN (or SENTRY_DSN) is required\n");
    exit(2);
}

$lang = 'php';
$release = getenv('HARNESS_RELEASE') ?: "$lang-harness@1.0.0";
$environment = getenv('HARNESS_ENV') ?: 'harness';

\Sentry\init([
    'dsn' => $dsn,
    'release' => $release,
    'environment' => $environment,
    'traces_sample_rate' => 1.0,
    'send_default_pii' => false,
    'attach_stacktrace' => true,
]);

\Sentry\configureScope(function (\Sentry\State\Scope $scope): void {
    $scope->setTag('lang', 'php');
    $scope->setTag('harness', 'error-tracker');
});

/** @var list<array{label: string, eventId: ?string}> $sent */
$sent = [];

/**
 * @param callable(): mixed $run
 */
function capture(string $label, callable $run, array &$sent): void
{
    $eventId = $run();
    if ($eventId !== null) {
        $eventId = (string) $eventId;
    }
    $sent[] = ['label' => $label, 'eventId' => $eventId];
    echo "sent $label event_id=" . ($eventId ?? '-') . "\n";
}

// 1. The simplest exception.
capture('simple', fn () => \Sentry\captureException(new \RuntimeException('php-harness: simple failure')), $sent);

// 2. A wrapper with a previous exception, to check exception chains.
$root = new \RuntimeException('php-harness: root cause');
$wrapper = new \RuntimeException('php-harness: wrapper failure', 0, $root);
capture('chained', fn () => \Sentry\captureException($wrapper), $sent);

// 3. A message event with no exception.
capture(
    'message',
    fn () => \Sentry\captureMessage('php-harness: warning message', \Sentry\Severity::warning()),
    $sent,
);

// 4. Tags, user and extra context on a scoped event.
capture('tags', function () {
    $eventId = null;
    \Sentry\withScope(function (\Sentry\State\Scope $scope) use (&$eventId): void {
        $scope->setTag('scenario', 'tags');
        $scope->setUser(['id' => 'user_123']);
        $scope->setExtra('orderId', 42);
        $scope->setExtra('token', 'sk_test_fake_secret_123456');
        $eventId = \Sentry\captureException(new \RuntimeException('php-harness: scoped failure'));
    });
    return $eventId;
}, $sent);

// 5. Values that must be masked before they reach the fingerprint.
capture(
    'normalize',
    fn () => \Sentry\captureException(
        new \RuntimeException(
            'php-harness: order 12345 failed for user 550e8400-e29b-41d4-a716-446655440000 after 3 tries',
        ),
    ),
    $sent,
);

// 6. Telemetry the tracker must accept and discard.
$context = new \Sentry\Tracing\TransactionContext('php-harness-transaction');
$context->setOp('harness');
$transaction = \Sentry\startTransaction($context);
\Sentry\SentrySdk::getCurrentHub()->setSpan($transaction);
$transaction->finish();
echo "sent telemetry transaction\n";

\Sentry\flush();
$flushed = true;

echo json_encode(
    ['lang' => $lang, 'release' => $release, 'environment' => $environment, 'sent' => $sent, 'flushed' => $flushed],
    JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT,
) . "\n";
