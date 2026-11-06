import { describe, expect, test } from 'bun:test';
import {
	FUNCTION_HEALTH_PATH,
	FUNCTION_INTERNAL_HEADER,
	FUNCTION_INTERNAL_PREFIX,
	FUNCTION_INTERNAL_VALUE,
} from '@skiff/contracts';
import { renderFunctionShim } from './function-shim.ts';

const render = (main = 'index.js'): string => renderFunctionShim({ main });

/** The `handleFetch` body, where the route order matters. */
function fetchHandler(source: string): string {
	const start = source.indexOf('async function handleFetch');
	expect(start).toBeGreaterThan(-1);
	return source.slice(start);
}

describe('renderFunctionShim', () => {
	test('imports the entry module by a relative specifier and re-exports its names', () => {
		const shim = render();
		expect(shim).toContain('import user from "./index.js";');
		expect(shim.match(/^import /gm)).toHaveLength(1);
		expect(shim).toContain('export default shim;');
		expect(shim).toContain('export * from "./index.js";');
		// The wildcard re-export comes after the default export so named exports pass through.
		expect(shim.indexOf('export default shim;')).toBeLessThan(shim.indexOf('export * from "./index.js";'));
	});

	test('imports a main module in a subdirectory without breaking out of the bundle', () => {
		const shim = render('src/index.js');
		expect(shim).toContain('import user from "./src/index.js";');
		expect(shim).toContain('export * from "./src/index.js";');
	});

	test('uses the contract paths and header names', () => {
		const shim = render();
		expect(shim).toContain(`const HEALTH_PATH = ${JSON.stringify(FUNCTION_HEALTH_PATH)};`);
		expect(shim).toContain(`const INTERNAL_PREFIX = ${JSON.stringify(FUNCTION_INTERNAL_PREFIX)};`);
		expect(shim).toContain(`const SCHEDULED_PATH = ${JSON.stringify(`${FUNCTION_INTERNAL_PREFIX}scheduled`)};`);
		expect(shim).toContain(`const QUEUE_PATH = ${JSON.stringify(`${FUNCTION_INTERNAL_PREFIX}queue`)};`);
		expect(shim).toContain(`const INTERNAL_HEADER = ${JSON.stringify(FUNCTION_INTERNAL_HEADER)};`);
		expect(shim).toContain(`const INTERNAL_VALUE = ${JSON.stringify(FUNCTION_INTERNAL_VALUE)};`);
		expect(shim).toContain('const CRON_HEADER = "x-skiff-cron";');
		expect(shim).toContain('const SCHEDULED_TIME_HEADER = "x-skiff-scheduled-time";');
		expect(shim).toContain('const QUEUE_HEADER = "x-skiff-queue";');
	});

	test('answers the public health probe without the internal header', () => {
		const shim = render();
		const fetch = fetchHandler(shim);
		// The health branch runs before the internal guard, so liveness never needs the header.
		expect(fetch.indexOf('HEALTH_PATH')).toBeGreaterThan(-1);
		expect(fetch.indexOf('HEALTH_PATH')).toBeLessThan(fetch.indexOf('INTERNAL_PREFIX'));
		expect(fetch.indexOf('INTERNAL_HEADER')).toBeGreaterThan(fetch.indexOf('HEALTH_PATH'));
		expect(shim).toContain(
			`return new Response('{"ok":true}', { status: 200, headers: JSON_HEADERS });`,
		);
		expect(shim).toContain(
			'const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };',
		);
	});

	test('hides every other /__skiff/ path without the internal value', () => {
		const shim = render();
		const fetch = fetchHandler(shim);
		expect(fetch).toContain('if (path.startsWith(INTERNAL_PREFIX)) {');
		expect(fetch).toContain(
			'if (request.headers.get(INTERNAL_HEADER) !== INTERNAL_VALUE) return notFound();',
		);
		expect(shim).toContain('function notFound() {\n\treturn new Response("Not Found", { status: 404 });\n}');
		// Scheduled/queue delivery sits behind the guard, never before it.
		expect(fetch.indexOf('SCHEDULED_PATH')).toBeGreaterThan(fetch.indexOf('INTERNAL_HEADER'));
		expect(fetch.indexOf('QUEUE_PATH')).toBeGreaterThan(fetch.indexOf('INTERNAL_HEADER'));
		// Anything else under the prefix, with the header, is still a 404 (no reflection).
		expect(fetch).toContain('return deliverQueue(request, env, ctx);\n\t\t}\n\t\treturn notFound();');
	});

	test('forwards fetch to the user worker and answers 501 when it has none', () => {
		const shim = render();
		expect(fetchHandler(shim)).toContain('return user.fetch(request, env, ctx);');
		expect(fetchHandler(shim)).toContain('if (!handles("fetch"))');
		expect(shim).toContain('function handles(name) {');
		expect(shim).toContain('function notImplemented(message) {\n\treturn json({ error: message }, 501);\n}');
		expect(shim).toContain('return notImplemented("this function has no fetch handler");');
	});

	test('delivers cron runs through POST /__skiff/scheduled', () => {
		const shim = render();
		expect(shim).toContain('async function deliverScheduled(request, env, ctx) {');
		expect(shim).toContain('if (!handles("scheduled"))');
		expect(shim).toContain('return notImplemented("this function has no scheduled handler");');
		expect(shim).toContain('const cron = request.headers.get(CRON_HEADER) ?? "";');
		expect(shim).toContain('const rawTime = request.headers.get(SCHEDULED_TIME_HEADER);');
		expect(shim).toContain('const scheduledTime = Number.isFinite(parsedTime) ? parsedTime : Date.now();');
		expect(shim).toContain('await user.scheduled({ cron, scheduledTime }, env, ctx);');
		expect(shim).toContain('return new Response(null, { status: 204 });');
		expect(fetchHandler(shim)).toContain('if (path === SCHEDULED_PATH) {');
		expect(fetchHandler(shim)).toContain('return deliverScheduled(request, env, ctx);');
	});

	test('delivers queue batches through POST /__skiff/queue', () => {
		const shim = render();
		expect(shim).toContain('async function deliverQueue(request, env, ctx) {');
		expect(shim).toContain('if (!handles("queue"))');
		expect(shim).toContain('return notImplemented("this function has no queue handler");');
		expect(shim).toContain('messages = await request.json();');
		expect(shim).toContain('return json({ error: "the queue batch body is not valid JSON" }, 400);');
		expect(shim).toContain('if (!Array.isArray(messages))');
		expect(shim).toContain('const batch = { queue: request.headers.get(QUEUE_HEADER) ?? "", messages };');
		expect(shim).toContain('await user.queue(batch, env, ctx);');
		expect(fetchHandler(shim)).toContain('if (path === QUEUE_PATH) {');
		expect(fetchHandler(shim)).toContain('return deliverQueue(request, env, ctx);');
	});

	test('only POSTs the internal delivery routes and 405s the rest', () => {
		const shim = render();
		const fetch = fetchHandler(shim);
		expect(fetch.match(/if \(request.method !== "POST"\) return methodNotAllowed\(\);/g)).toHaveLength(2);
		expect(shim).toContain(
			'return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });',
		);
	});

	test('exposes scheduled and queue only when the user exports them', () => {
		const shim = render();
		expect(shim).toContain('if (handles("scheduled")) {\n\tshim.scheduled =');
		expect(shim).toContain('if (handles("queue")) {\n\tshim.queue =');
		expect(shim).toContain('const shim = { fetch: handleFetch };');
		expect(shim).toContain('export default shim;');
	});

	test('is plain ESM that workerd can load without nodejs_compat', () => {
		const shim = render();
		expect(shim).not.toContain('eval(');
		expect(shim).not.toContain('new Function');
		expect(shim).not.toContain('require(');
		expect(shim).not.toMatch(/from "node:/);
		expect(shim).not.toMatch(/^await\s/m);
		expect(shim).not.toMatch(/^import\s*\(/m);
	});

	test('refuses an unsafe entry module name', () => {
		for (const main of [
			'',
			'/etc/passwd',
			'../index.js',
			'src/../index.js',
			'a/../../b.js',
			'a\\b.js',
			'a"b.js',
			"a'b.js",
			'a\nb.js',
			'a\rb.js',
		]) {
			expect(() => renderFunctionShim({ main })).toThrow(/not a safe relative specifier|must be/);
		}
	});

	test('is syntactically valid ESM', () => {
		// Parsing only: the module imports the user's entry module, which does not exist here.
		expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(render('src/index.js'))).not.toThrow();
	});

	test('is deterministic', () => {
		expect(render()).toBe(render());
		expect(render('src/index.js')).toBe(render('src/index.js'));
	});
});
