import { describe, expect, test } from 'bun:test';
import { expandRegistryTag } from './actions.ts';

describe('expandRegistryTag (docs/REGISTRY.md)', () => {
	const registry = { host: 'registry.example.com', namespace: 'registry.example.com/acme', push: true };

	test('expands registry/<name> into the org namespace and registry/<org>/<name> onto the host', () => {
		expect(expandRegistryTag('registry/api:1', registry)).toBe('registry.example.com/acme/api:1');
		expect(expandRegistryTag('registry/acme/api:1', registry)).toBe('registry.example.com/acme/api:1');
		expect(expandRegistryTag('registry/api@sha256:abc', registry)).toBe('registry.example.com/acme/api@sha256:abc');
	});

	test('leaves other references alone and explains a registry that is off', () => {
		expect(expandRegistryTag('ghcr.io/acme/api:1', registry)).toBe('ghcr.io/acme/api:1');
		expect(() => expandRegistryTag('registry/api:1', null)).toThrow(/registry is off/);
	});
});
