/**
 * The setup snippets for each SDK the Errors setup offers (docs/APP-ERRORS.md §5). One source for
 * the Setup tab, so a snippet never drifts between screens. Pure: the page passes the DSN and
 * the optional tags, and gets back exactly what the user pastes.
 */

export type SdkId = 'node' | 'browser' | 'php' | 'go' | 'python' | 'static';

export interface SdkOptions {
	/** The target DSN, or a placeholder before a target exists. */
	dsn: string;
	environment: string;
	release: string;
	/**
	 * Read the DSN from the environment Yoal injects into a linked project's workloads
	 * (`SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT`) instead of pasting it.
	 */
	injected: boolean;
	/** The control plane origin, for `/e.js`. */
	origin: string;
}

export interface Sdk {
	id: SdkId;
	label: string;
	/** The package a reader recognises. */
	package: string;
	/** Short line under the tile. */
	blurb: string;
	/** Runs on a server Yoal deploys, so the injected environment reaches it. */
	server: boolean;
	install: string | null;
	/** File label for the init snippet; it also picks the highlighter. */
	file: string;
	lang: string;
	init: (options: SdkOptions) => string;
	/** One line that reports a handled error, to prove the wiring from inside the app. */
	verify: string;
}

export const PLACEHOLDER_DSN = 'https://<key>@<platform>/ingest/<id>';

function tagLines(
	options: SdkOptions,
	format: (key: 'environment' | 'release', value: string) => string
): string[] {
	const lines: string[] = [];
	if (options.environment.trim()) lines.push(format('environment', options.environment.trim()));
	if (options.release.trim()) lines.push(format('release', options.release.trim()));
	return lines;
}

export const SDKS: readonly Sdk[] = [
	{
		id: 'node',
		label: 'Node / Bun',
		package: '@sentry/node',
		blurb: 'Servers, workers, SvelteKit, Next.js server side',
		server: true,
		install: 'bun add @sentry/node   # or: npm install @sentry/node',
		file: 'instrument.ts',
		lang: 'typescript',
		init: (options) => {
			if (options.injected)
				return [
					`import * as Sentry from '@sentry/node';`,
					``,
					`// Yoal injects SENTRY_DSN, SENTRY_RELEASE and SENTRY_ENVIRONMENT.`,
					`Sentry.init({ dsn: process.env.SENTRY_DSN });`
				].join('\n');
			return [
				`import * as Sentry from '@sentry/node';`,
				``,
				`Sentry.init({`,
				`  dsn: '${options.dsn}',`,
				...tagLines(options, (key, value) => `  ${key}: '${value}',`),
				`});`
			].join('\n');
		},
		verify: `Sentry.captureException(new Error('Hello from Yoal'));`
	},
	{
		id: 'browser',
		label: 'Browser',
		package: '@sentry/browser',
		blurb: 'Bundled front ends: Vite, React, Svelte, Vue',
		server: false,
		install: 'bun add @sentry/browser   # or: npm install @sentry/browser',
		file: 'main.ts',
		lang: 'typescript',
		init: (options) =>
			[
				`import * as Sentry from '@sentry/browser';`,
				``,
				`Sentry.init({`,
				`  dsn: '${options.dsn}',`,
				...tagLines(options, (key, value) => `  ${key}: '${value}',`),
				`});`
			].join('\n'),
		verify: `Sentry.captureException(new Error('Hello from Yoal'));`
	},
	{
		id: 'static',
		label: 'Static site',
		package: 'e.js',
		blurb: 'One script tag, no build step',
		server: false,
		install: null,
		file: 'index.html',
		lang: 'html',
		init: (options) => {
			const attributes = [
				`data-dsn="${options.dsn}"`,
				...tagLines(options, (key, value) => `data-${key}="${value}"`)
			];
			return `<script src="${options.origin.replace(/\/$/, '')}/e.js"\n        ${attributes.join('\n        ')}></script>`;
		},
		verify: `setTimeout(() => { throw new Error('Hello from Yoal'); });`
	},
	{
		id: 'php',
		label: 'PHP',
		package: 'sentry/sentry',
		blurb: 'Laravel, Symfony or plain PHP',
		server: true,
		install: 'composer require sentry/sentry',
		file: 'bootstrap.php',
		lang: 'php',
		init: (options) => {
			if (options.injected)
				return [
					`<?php`,
					`// Yoal injects SENTRY_DSN, SENTRY_RELEASE and SENTRY_ENVIRONMENT.`,
					`\\Sentry\\init(['dsn' => getenv('SENTRY_DSN')]);`
				].join('\n');
			return [
				`<?php`,
				`\\Sentry\\init([`,
				`    'dsn' => '${options.dsn}',`,
				...tagLines(options, (key, value) => `    '${key}' => '${value}',`),
				`]);`
			].join('\n');
		},
		verify: `\\Sentry\\captureException(new \\Exception('Hello from Yoal'));`
	},
	{
		id: 'go',
		label: 'Go',
		package: 'sentry-go',
		blurb: 'net/http, Gin, Echo, Fiber',
		server: true,
		install: 'go get github.com/getsentry/sentry-go',
		file: 'main.go',
		lang: 'go',
		init: (options) => {
			const fields = options.injected
				? [
						`\t\t// Yoal injects SENTRY_DSN, SENTRY_RELEASE and SENTRY_ENVIRONMENT.`,
						`\t\tDsn: os.Getenv("SENTRY_DSN"),`
					]
				: [
						`\t\tDsn: "${options.dsn}",`,
						...tagLines(options, (key, value) =>
							key === 'environment' ? `\t\tEnvironment: "${value}",` : `\t\tRelease: "${value}",`
						)
					];
			return [
				`import (`,
				`\t"log"`,
				...(options.injected ? [`\t"os"`] : []),
				`\t"time"`,
				``,
				`\t"github.com/getsentry/sentry-go"`,
				`)`,
				``,
				`func main() {`,
				`\terr := sentry.Init(sentry.ClientOptions{`,
				...fields,
				`\t})`,
				`\tif err != nil {`,
				`\t\tlog.Fatalf("sentry.Init: %s", err)`,
				`\t}`,
				`\tdefer sentry.Flush(2 * time.Second)`,
				`}`
			].join('\n');
		},
		verify: `sentry.CaptureException(errors.New("Hello from Yoal"))`
	},
	{
		id: 'python',
		label: 'Python',
		package: 'sentry-sdk',
		blurb: 'Django, Flask, FastAPI',
		server: true,
		install: 'pip install sentry-sdk',
		file: 'app.py',
		lang: 'python',
		init: (options) => {
			if (options.injected)
				return [
					`import os`,
					`import sentry_sdk`,
					``,
					`# Yoal injects SENTRY_DSN, SENTRY_RELEASE and SENTRY_ENVIRONMENT.`,
					`sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"))`
				].join('\n');
			return [
				`import sentry_sdk`,
				``,
				`sentry_sdk.init(`,
				`    dsn="${options.dsn}",`,
				...tagLines(options, (key, value) => `    ${key}="${value}",`),
				`)`
			].join('\n');
		},
		verify: `sentry_sdk.capture_exception(Exception("Hello from Yoal"))`
	}
];

export function sdkById(id: string | null | undefined): Sdk {
	return SDKS.find((sdk) => sdk.id === id) ?? SDKS[0]!;
}

/**
 * A `curl` that posts one event to the legacy store endpoint with query-string auth, so a DSN can
 * be proven from a terminal without installing anything. Null for a placeholder or malformed DSN.
 */
export function storeCurl(dsn: string | null | undefined): string | null {
	if (!dsn) return null;
	let url: URL;
	try {
		url = new URL(dsn);
	} catch {
		return null;
	}
	const key = decodeURIComponent(url.username);
	const match = /^(.*)\/ingest\/(\d+)\/?$/.exec(url.pathname);
	if (!key || !/^[0-9a-f]+$/i.test(key) || !match) return null;
	const endpoint = `${url.protocol}//${url.host}${match[1]}/ingest/api/${match[2]}/store/?sentry_key=${key}&sentry_version=7`;
	return [
		`curl -X POST '${endpoint}' \\`,
		`  -H 'Content-Type: application/json' \\`,
		`  -d '{"level":"error","platform":"other","exception":{"values":[{"type":"Error","value":"Hello from curl"}]}}'`
	].join('\n');
}
