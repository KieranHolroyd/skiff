/* Yoal app-errors browser snippet (docs/APP-ERRORS.md). No dependencies, no build step.
 *
 *   <script src="https://<platform>/e.js" data-dsn="https://<key>@<platform>/ingest/<id>"></script>
 *
 * Sends a Sentry `store` event with query-string auth and `text/plain`, so a cross-origin page
 * needs no preflight. Only exceptions are sent; there are no breadcrumbs, sessions or replays.
 */
(function () {
	'use strict';
	var script = document.currentScript;
	var dsn = (script && script.getAttribute('data-dsn')) || window.YOAL_ERRORS_DSN || '';
	if (!dsn) return;

	var release = (script && script.getAttribute('data-release')) || undefined;
	var environment =
		(script && script.getAttribute('data-environment')) ||
		(location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'development' : 'production');
	var endpoint;
	var key;
	try {
		var url = new URL(dsn);
		key = decodeURIComponent(url.username);
		var base = url.protocol + '//' + url.host + url.pathname.replace(/\/$/, '');
		var eventId = base.slice(base.lastIndexOf('/') + 1);
		endpoint = base.slice(0, base.lastIndexOf('/')) + '/api/' + encodeURIComponent(eventId) + '/store/';
		if (!key || !/^\d+$/.test(eventId)) return;
	} catch (_) {
		return;
	}

	var seen = Object.create(null);
	var queue = [];

	function randomId() {
		var bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		var out = '';
		for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
		return out;
	}

	function frames(stack) {
		if (!stack) return [];
		var out = [];
		var lines = String(stack).split('\n');
		for (var i = 0; i < lines.length; i++) {
			var match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(lines[i]);
			if (!match) continue;
			var file = match[2] || '';
			if (!file || /chrome-extension:|moz-extension:|node_modules|\/yoal-e\.js$/.test(file)) continue;
			out.push({
				function: (match[1] || '<anonymous>').replace(/^async /, ''),
				filename: file.replace(/^https?:\/\/[^/]+/, ''),
				lineno: Number(match[3]),
				colno: Number(match[4]),
				in_app: true
			});
			if (out.length >= 50) break;
		}
		return out.reverse();
	}

	function exceptionFrom(value) {
		if (value && typeof value === 'object' && typeof value.message === 'string') {
			return {
				type: value.name || 'Error',
				value: value.message,
				stacktrace: { frames: frames(value.stack) }
			};
		}
		return { type: 'Error', value: String(value || 'Unknown error'), stacktrace: { frames: [] } };
	}

	function send(event) {
		var body = JSON.stringify(event);
		var url = endpoint + '?sentry_version=7&sentry_key=' + encodeURIComponent(key) + '&sentry_client=yoal-e.js/1';
		if (queue.length < 20) queue.push({ url: url, body: body });
		try {
			fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: body,
				keepalive: true,
				credentials: 'omit',
				mode: 'cors'
			}).catch(function () {});
		} catch (_) {}
	}

	function capture(value, extra) {
		var exception = exceptionFrom(value);
		var fingerprint = exception.type + '|' + exception.value + '|' + (exception.stacktrace.frames[0] || {}).function;
		if (seen[fingerprint]) return;
		seen[fingerprint] = true;
		setTimeout(function () {
			delete seen[fingerprint];
		}, 1000);

		var event = {
			event_id: randomId(),
			timestamp: Date.now() / 1000,
			platform: 'javascript',
			level: 'error',
			environment: environment,
			exception: { values: [exception] },
			request: { url: location.origin + location.pathname },
			tags: { lang: 'javascript' }
		};
		if (release) event.release = release;
		if (extra) {
			for (var name in extra) {
				if (Object.prototype.hasOwnProperty.call(extra, name)) event[name] = extra[name];
			}
		}
		send(event);
	}

	window.addEventListener(
		'error',
		function (event) {
			var message = event.message || '';
			if (/ResizeObserver loop/.test(message)) return;
			capture(event.error || message, event.error ? { lineno: event.lineno, colno: event.colno } : undefined);
		},
		true
	);
	window.addEventListener('unhandledrejection', function (event) {
		capture(event.reason);
	});
	window.addEventListener('pagehide', function () {
		if (!navigator.sendBeacon) return;
		for (var i = 0; i < queue.length; i++) {
			try {
				navigator.sendBeacon(queue[i].url, new Blob([queue[i].body], { type: 'text/plain' }));
			} catch (_) {}
		}
		queue = [];
	});

	window.YoalErrors = {
		captureException: function (error, extra) {
			capture(error, extra);
		}
	};
})();
