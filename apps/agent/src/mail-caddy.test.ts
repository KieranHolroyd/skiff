import { describe, expect, test } from 'bun:test';
import { desiredStateSchema, mailHostnames } from '@yoal/contracts';
import { buildCaddyConfig } from './caddy-config.ts';

type Json = Record<string, unknown>;

function compile(mail: boolean) {
	const state = desiredStateSchema.parse({
		version: 1,
		nodeId: 'node_1',
		agentVersion: '0.1.0',
		generatedAt: '2026-11-07T00:00:00Z',
		contentDomain: 'example.com',
		releases: [],
		routes: [],
		platformOrigin: 'https://cloud.example.com',
		mail: mail ? { generation: 1, hostnames: mailHostnames('example.dev') } : null,
	});
	return buildCaddyConfig({
		state,
		listen: [':443'],
		dataDir: '/data',
		agentSocket: '/run/yoal-agent/agent.sock',
		caddyAdminSocket: '/var/lib/caddy/admin.sock',
		tls: { email: 'ops@example.com', cloudflareApiToken: 'cf-token', subjects: ['*.example.com', 'example.com'] },
	});
}

describe('mail certificates in Caddy (docs/EMAIL.md §3.2)', () => {
	test('the mail node manages smtp.* and mx.* without routes', () => {
		const tls = (compile(true).apps as Json).tls as Json;
		expect((tls.certificates as Json).automate).toEqual(['smtp.example.dev', 'mx.example.dev']);
		const policies = (tls.automation as Json).policies as Json[];
		expect(policies.at(-1)!.subjects).toEqual(['smtp.example.dev', 'mx.example.dev']);
		expect(JSON.stringify(compile(true).apps)).not.toContain('"host":["smtp.example.dev"]');
	});

	test('other nodes are untouched', () => {
		const tls = (compile(false).apps as Json).tls as Json;
		expect(tls.certificates).toBeUndefined();
		expect((tls.automation as Json).policies as Json[]).toHaveLength(1);
	});
});
