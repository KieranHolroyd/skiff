<?php
declare(strict_types=1);

// A minimal PHP app for Skiff. `/data` style state lives in $STATE_DIRECTORY (writable, private to
// this app, kept across restarts and idle stops).
$state = getenv('STATE_DIRECTORY') ?: sys_get_temp_dir();
$counterFile = $state . '/hits';
$hits = (int) @file_get_contents($counterFile) + 1;
file_put_contents($counterFile, (string) $hits, LOCK_EX);

header('Content-Type: application/json');
echo json_encode([
	'php' => PHP_VERSION,
	'sapi' => PHP_SAPI,
	'hits' => $hits,
	// Set by systemd when the socket started this process; absent when the app is always on.
	'socketActivated' => getenv('LISTEN_FDS') !== false,
	'pid' => getmypid(),
], JSON_PRETTY_PRINT) . "\n";
