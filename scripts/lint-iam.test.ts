import { describe, expect, test } from 'bun:test';
import { newViolations, toBaseline, type Finding } from './lint-iam.ts';

function finding(file: string, rule: Finding['rule'], line = 1): Finding {
	return { file, line, rule, text: 'principal.role === "owner"' };
}

describe('iam lint baseline', () => {
	test('counts findings per file and rule', () => {
		expect(
			toBaseline([
				finding('a.ts', 'role'),
				finding('a.ts', 'role', 2),
				finding('a.ts', 'kind'),
				finding('b.ts', 'kind'),
			]),
		).toEqual({ 'a.ts': { role: 2, kind: 1 }, 'b.ts': { kind: 1 } });
	});

	test('allows existing findings and rejects any extra one', () => {
		const baseline = { 'a.ts': { role: 1 } };
		expect(newViolations([finding('a.ts', 'role')], baseline)).toEqual([]);
		expect(newViolations([finding('a.ts', 'role'), finding('a.ts', 'role', 2)], baseline)).toHaveLength(1);
		expect(newViolations([finding('a.ts', 'kind')], baseline)).toHaveLength(1);
	});

	test('a new file is a new violation', () => {
		expect(newViolations([finding('b.ts', 'kind')], {})).toHaveLength(1);
	});
});
