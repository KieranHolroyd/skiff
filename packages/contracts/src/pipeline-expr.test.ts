import { describe, expect, test } from 'bun:test';
import type { PipelineExpressionContext } from './pipeline.ts';
import {
	containsStatusFunction,
	evaluateCondition,
	evaluateExpression,
	expressionFunctions,
	expressionReferences,
	extractExpressions,
	hasTemplate,
	interpolate,
	interpolateValue,
	PipelineExpressionError,
	unwrapExpression,
} from './pipeline-expr.ts';

const ctx: PipelineExpressionContext = {
	yoal: {
		event_name: 'push',
		ref: 'refs/heads/main',
		sha: 'abc123',
		event: {
			issue: { labels: [{ name: 'bug' }, { name: 'help wanted' }] },
			commits: [{ message: 'one' }, { message: 'two' }],
		},
	},
	env: { MY_VAR: 'hello', EMPTY: '' },
	vars: { Region: 'eu' },
	secrets: { TOKEN: 's3cret' },
	inputs: { promote: true, count: 3 },
	matrix: { os: 'linux', node: 20 },
	needs: {
		build: { result: 'success', outputs: { digest: 'sha256:1' } },
		test: { result: 'failure', outputs: {} },
	},
	steps: { 'my-step': { outcome: 'success', conclusion: 'success', outputs: { path: '/tmp/x' } } },
	job: {
		fruits: [
			{ name: 'apple', quantity: 1 },
			{ name: 'orange', quantity: 2 },
			{ name: 'pear', quantity: 1 },
		],
		vegetables: {
			scallions: { colors: ['green', 'white', 'red'], ediblePortions: ['roots', 'stems'] },
			beets: { colors: ['purple', 'red', 'gold'], ediblePortions: ['roots', 'stems'] },
			artichokes: { colors: ['green', 'purple'], ediblePortions: ['hearts', 'stems', 'leaves'] },
		},
	},
};

const ev = (expr: string): unknown => evaluateExpression(expr, ctx);

describe('literals', () => {
	test.each([
		['null', null],
		['true', true],
		['false', false],
		['711', 711],
		['-9.2', -9.2],
		['0xff', 255],
		['-2.99e-2', -0.0299],
		['1e3', 1000],
		['.5', 0.5],
		["'Mona the Octocat'", 'Mona the Octocat'],
		["'It''s open source!'", "It's open source!"],
		["''", ''],
		['Infinity', Number.POSITIVE_INFINITY],
	])('%s', (expr, expected) => {
		expect(ev(expr)).toEqual(expected);
	});

	test('NaN literal', () => {
		expect(Number.isNaN(ev('NaN'))).toBe(true);
	});
});

describe('loose equality and coercion (GitHub docs)', () => {
	test.each([
		// null → 0, booleans → 0/1, strings parsed as numbers ('' → 0), arrays/objects never equal primitives
		['null == 0', true],
		['null == false', true],
		["null == ''", true],
		['true == 1', true],
		['false == 0', true],
		["true == 'true'", false],
		["'1' == 1", true],
		["'' == 0", true],
		["' 1 ' == 1", true],
		["'0x10' == 16", true],
		["'1e2' == 100", true],
		["'abc' == 0", false],
		['null == null', true],
		["'abc' == 'ABC'", true],
		["'abc' != 'ABD'", true],
		['NaN == NaN', false],
		['NaN != NaN', true],
		['yoal.event == yoal.event', true],
		['yoal.event == yoal.event.issue', false],
		["fromJSON('[]') == fromJSON('[]')", false],
		["fromJSON('[]') == 0", false],
		["fromJSON('{}') == ''", false],
		// relational
		['1 < 2', true],
		['2 <= 2', true],
		['3 > 2', true],
		['2 >= 3', false],
		["'a' < 'B'", true],
		["'B' > 'a'", true],
		["'abc' >= 'ABC'", true],
		['null < 1', true],
		["'10' > 9", true],
		['NaN < 1', false],
		['NaN >= NaN', false],
		["'x' < 1", false],
		["fromJSON('[]') < 1", false],
		['false < true', true],
	])('%s → %p', (expr, expected) => {
		expect(ev(expr)).toBe(expected);
	});
});

describe('logical operators', () => {
	test('&& and || return operand values', () => {
		expect(ev("'a' && 'b'")).toBe('b');
		expect(ev("'' && 'b'")).toBe('');
		expect(ev("'' || 'b'")).toBe('b');
		expect(ev("'a' || 'b'")).toBe('a');
		expect(ev('0 || null')).toBe(null);
		expect(ev("yoal.event_name == 'push' && 'deploy' || 'skip'")).toBe('deploy');
		expect(ev("yoal.event_name == 'pr' && 'deploy' || 'skip'")).toBe('skip');
	});

	test('! coerces with truthiness', () => {
		expect(ev('!0')).toBe(true);
		expect(ev("!''")).toBe(true);
		expect(ev('!null')).toBe(true);
		expect(ev('!NaN')).toBe(true);
		expect(ev("!'false'")).toBe(false);
		expect(ev("!fromJSON('[]')")).toBe(false);
		expect(ev('!!1')).toBe(true);
	});

	test('precedence: ! > comparison > equality > && > ||', () => {
		expect(ev('true || false && false')).toBe(true);
		expect(ev('(true || false) && false')).toBe(false);
		expect(ev('1 < 2 == true')).toBe(true);
		expect(ev('!1 == false')).toBe(true);
		expect(ev('1 == 1 && 2 == 2')).toBe(true);
	});

	test('short-circuits: the right side is not evaluated', () => {
		expect(ev("false && fromJSON('not json')")).toBe(false);
		expect(ev("true || fromJSON('not json')")).toBe(true);
	});
});

describe('property access', () => {
	test('dot, index and case-insensitive lookup', () => {
		expect(ev('yoal.sha')).toBe('abc123');
		expect(ev("yoal['sha']")).toBe('abc123');
		expect(ev('YOAL.SHA')).toBe('abc123');
		expect(ev('vars.region')).toBe('eu');
		expect(ev("steps.my-step.outputs.path")).toBe('/tmp/x');
		expect(ev("steps['my-step'].outputs['path']")).toBe('/tmp/x');
		expect(ev('needs.build.outputs.digest')).toBe('sha256:1');
		expect(ev('yoal.event.commits[1].message')).toBe('two');
		expect(ev("yoal.event.commits['0'].message")).toBe('one');
	});

	test('github is an alias of yoal', () => {
		expect(ev('github.sha')).toBe('abc123');
		expect(ev("github.ref == 'refs/heads/main'")).toBe(true);
	});

	test('missing properties are null, never errors', () => {
		expect(ev('yoal.nope')).toBe(null);
		expect(ev('yoal.nope.deeper.still')).toBe(null);
		expect(ev('yoal.event.commits[9]')).toBe(null);
		expect(ev('yoal.event.commits[-1]')).toBe(null);
		expect(ev('yoal.sha.length')).toBe(null);
		expect(ev('runner.os')).toBe(null);
		expect(evaluateExpression('matrix.os', { yoal: {} })).toBe(null);
	});

	test('does not reach prototype properties', () => {
		expect(ev('yoal.constructor')).toBe(null);
		expect(ev("yoal['__proto__']")).toBe(null);
		expect(ev('yoal.toString')).toBe(null);
	});

	test('object filters (GitHub docs)', () => {
		expect(ev('job.fruits.*.name')).toEqual(['apple', 'orange', 'pear']);
		expect(ev('job.fruits[*].quantity')).toEqual([1, 2, 1]);
		expect(ev('job.vegetables.*.ediblePortions')).toEqual([
			['roots', 'stems'],
			['roots', 'stems'],
			['hearts', 'stems', 'leaves'],
		]);
		expect(ev('job.vegetables.*.ediblePortions.*')).toEqual(['roots', 'stems', 'roots', 'stems', 'hearts', 'stems', 'leaves']);
		expect(ev("contains(job.vegetables.*.ediblePortions.*, 'leaves')")).toBe(true);
		expect(ev('job.fruits.*.missing')).toEqual([]);
		expect(ev('yoal.sha.*')).toEqual([]);
		expect(ev('needs.*.result')).toEqual(['success', 'failure']);
		expect(ev("contains(needs.*.result, 'failure')")).toBe(true);
	});
});

describe('functions', () => {
	test.each([
		["contains('Hello world', 'llo')", true],
		["contains('Hello world', 'LLO')", true],
		["contains('Hello world', 'xyz')", false],
		["contains(yoal.event.issue.labels.*.name, 'bug')", true],
		["contains(yoal.event.issue.labels.*.name, 'BUG')", true],
		["contains(fromJSON('[\"push\", \"pull_request\"]'), yoal.event_name)", true],
		["contains(fromJSON('[1, 2]'), '2')", true],
		["contains(yoal.event, 'issue')", false],
		["contains(123, 2)", true],
		["startsWith('Hello world', 'he')", true],
		["startsWith('Hello world', 'world')", false],
		["endsWith('Hello world', 'LD')", true],
		["endsWith(fromJSON('[1]'), '1')", false],
		["format('Hello {0} {1} {2}', 'Mona', 'the', 'Octocat')", 'Hello Mona the Octocat'],
		["format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')", '{Hello Mona the Octocat!}'],
		["format('{0}{0}-{1}', 1, true)", '11-true'],
		["format('{0}', null)", ''],
		["join(yoal.event.issue.labels.*.name, ', ')", 'bug, help wanted'],
		["join(fromJSON('[1, true, null, \"x\"]'))", '1,true,,x'],
		["join('abc', '-')", 'abc'],
		['join(yoal.event)', ''],
		["fromJSON('{\"a\": [1, 2]}').a[1]", 2],
		["fromJSON('true')", true],
		["fromJSON('5') == 5", true],
		['toJSON(1)', '1'],
		["toJSON('x')", '"x"'],
		['toJSON(null)', 'null'],
		["toJSON(fromJSON('{\"a\":[1,2]}'))", '{\n  "a": [\n    1,\n    2\n  ]\n}'],
		['toJSON(needs.build.outputs)', '{\n  "digest": "sha256:1"\n}'],
		['CONTAINS(\'ab\', \'b\')', true],
		['ToJson(true)', 'true'],
	])('%s', (expr, expected) => {
		expect(ev(expr)).toEqual(expected);
	});

	test('format rejects bad format strings', () => {
		expect(() => ev("format('{0} {1}', 'a')")).toThrow(PipelineExpressionError);
		expect(() => ev("format('{', 'a')")).toThrow(PipelineExpressionError);
		expect(() => ev("format('}', 'a')")).toThrow(PipelineExpressionError);
		expect(() => ev("format('{x}', 'a')")).toThrow(PipelineExpressionError);
	});

	test('fromJSON rejects invalid JSON', () => {
		expect(() => ev("fromJSON('{nope')")).toThrow(PipelineExpressionError);
		expect(() => ev("fromJSON('')")).toThrow(PipelineExpressionError);
	});

	test('hashFiles delegates to the callback', () => {
		const seen: string[][] = [];
		const hash = evaluateExpression("hashFiles('**/bun.lock', 'package.json')", ctx, {
			hashFiles: (patterns) => {
				seen.push(patterns);
				return 'deadbeef';
			},
		});
		expect(hash).toBe('deadbeef');
		expect(seen).toEqual([['**/bun.lock', 'package.json']]);
		expect(() => ev("hashFiles('x')")).toThrow(/only available/);
		expect(() =>
			evaluateExpression("hashFiles('x')", ctx, {
				hashFiles: () => {
					throw new Error('disk on fire');
				},
			}),
		).toThrow(PipelineExpressionError);
	});

	test('status functions', () => {
		const ok = { status: { failed: false, cancelled: false } };
		const failed = { status: { failed: true, cancelled: false } };
		const cancelled = { status: { failed: true, cancelled: true } };
		expect(evaluateExpression('success()', ctx, ok)).toBe(true);
		expect(evaluateExpression('success()', ctx, failed)).toBe(false);
		expect(evaluateExpression('failure()', ctx, ok)).toBe(false);
		expect(evaluateExpression('failure()', ctx, failed)).toBe(true);
		expect(evaluateExpression('failure()', ctx, cancelled)).toBe(false);
		expect(evaluateExpression('cancelled()', ctx, cancelled)).toBe(true);
		expect(evaluateExpression('success()', ctx, cancelled)).toBe(false);
		expect(evaluateExpression('always()', ctx, cancelled)).toBe(true);
		expect(evaluateExpression('success()', ctx)).toBe(true);
	});
});

describe('parse errors', () => {
	test.each([
		'',
		'   ',
		'1 +',
		'a.b',
		'unknown',
		'yoal.',
		'yoal[',
		"yoal['a'",
		"'unterminated",
		'1 = 1',
		'1 & 1',
		'1 | 1',
		'(1',
		'1)',
		'nope()',
		'contains(1)',
		'success(1)',
		'format()',
		'join(1, 2, 3)',
		'1 2',
		'#',
		'-x',
		'1..2',
		'0o9',
		'yoal.1',
		'True',
		'('.repeat(60) + '1' + ')'.repeat(60),
		'!'.repeat(60) + '1',
		'x'.repeat(21_001),
	])('%p is a PipelineExpressionError', (expr) => {
		expect(() => ev(expr)).toThrow(PipelineExpressionError);
	});

	test('messages name the problem and position', () => {
		expect(() => ev('foo.bar')).toThrow("Unrecognized named-value 'foo' at position 1");
		expect(() => ev("contains('a')")).toThrow("Function 'contains' takes 2 argument(s), got 1");
	});
});

describe('interpolate', () => {
	test('strings without templates are returned unchanged', () => {
		expect(interpolate('plain $text {{ x }}', ctx)).toBe('plain $text {{ x }}');
	});

	test('replaces every template and stringifies like GitHub', () => {
		expect(interpolate('ref=${{ yoal.ref }} sha=${{ github.sha }}', ctx)).toBe('ref=refs/heads/main sha=abc123');
		expect(interpolate('[${{ null }}]', ctx)).toBe('[]');
		expect(interpolate('${{ true }}/${{ 1 == 2 }}', ctx)).toBe('true/false');
		expect(interpolate('${{ 3 }} ${{ 1.5 }} ${{ 0.1 }} ${{ 1e20 }} ${{ -0 }} ${{ 0.00001 }}', ctx)).toBe('3 1.5 0.1 1E+20 0 1E-05');
		expect(interpolate('${{ 123456789012345 }}', ctx)).toBe('123456789012345');
		expect(interpolate('${{ needs.build.outputs }}', ctx)).toBe('{\n  "digest": "sha256:1"\n}');
		expect(interpolate('${{ matrix.missing }}x', ctx)).toBe('x');
	});

	test('}} inside quoted strings does not end the template', () => {
		expect(interpolate("a ${{ '}}' }} b", ctx)).toBe('a }} b');
		expect(interpolate("${{ format('{{0}}', 1) }}", ctx)).toBe('{0}');
		expect(interpolate("${{ 'it''s }}' }}!", ctx)).toBe("it's }}!");
	});

	test('unterminated templates throw', () => {
		expect(() => interpolate('${{ yoal.sha', ctx)).toThrow(PipelineExpressionError);
		expect(() => interpolate("${{ '}} ", ctx)).toThrow(PipelineExpressionError);
	});

	test('interpolateValue returns raw values for a lone template', () => {
		expect(interpolateValue("${{ fromJSON('{\"os\":[\"a\",\"b\"]}') }}", ctx)).toEqual({ os: ['a', 'b'] });
		expect(interpolateValue('  ${{ inputs.promote }}  ', ctx)).toBe(true);
		expect(interpolateValue('${{ inputs.count }}', ctx)).toBe(3);
		expect(interpolateValue('v${{ inputs.count }}', ctx)).toBe('v3');
		expect(interpolateValue('${{ 1 }}${{ 2 }}', ctx)).toBe('12');
		expect(interpolateValue('plain', ctx)).toBe('plain');
	});

	test('template helpers', () => {
		expect(hasTemplate('a ${{ b }}')).toBe(true);
		expect(hasTemplate('a { b }')).toBe(false);
		expect(extractExpressions("${{ a }} and ${{ '}}' }}")).toEqual([' a ', " '}}' "]);
		expect(unwrapExpression(' ${{ x == 1 }} ')).toBe(' x == 1 ');
		expect(unwrapExpression('${{ a }} ${{ b }}')).toBe(null);
		expect(unwrapExpression('x == 1')).toBe(null);
	});
});

describe('evaluateCondition (if:)', () => {
	const ok = { status: { failed: false, cancelled: false } };
	const failed = { status: { failed: true, cancelled: false } };
	const cancelled = { status: { failed: false, cancelled: true } };

	test.each([
		// [condition, status, expected]
		[null, ok, true],
		['', ok, true],
		[null, failed, false],
		['true', ok, true],
		['true', failed, false], // implicit success() &&
		["yoal.ref == 'refs/heads/main'", ok, true],
		["${{ yoal.ref == 'refs/heads/main' }}", ok, true],
		["${{ yoal.ref == 'refs/heads/dev' }}", ok, false],
		["yoal.ref == 'refs/heads/main'", failed, false],
		['failure()', failed, true],
		['failure()', ok, false],
		['always()', failed, true],
		['always()', cancelled, true],
		['cancelled()', cancelled, true],
		['success()', cancelled, false],
		["failure() && yoal.ref == 'refs/heads/main'", failed, true],
		['!cancelled()', failed, true],
		['${{ always() }}', failed, true],
		["'false'", ok, true], // a non-empty string is truthy
		['0', ok, false],
		['null', ok, false],
		["env.EMPTY", ok, false],
		["inputs.promote", ok, true],
		["contains(needs.*.result, 'failure')", ok, true],
		["${{ yoal.ref }} == 'nope'", ok, true], // GitHub's mixed-text trap: a non-empty string
		["${{ yoal.ref }} == 'nope'", failed, false],
	] as const)('%p (%p) → %p', (condition, options, expected) => {
		expect(evaluateCondition(condition, ctx, options)).toBe(expected);
	});

	test('the right side is not evaluated once success() is false', () => {
		expect(evaluateCondition("fromJSON('bad')", ctx, failed)).toBe(false);
		expect(() => evaluateCondition("fromJSON('bad')", ctx, ok)).toThrow(PipelineExpressionError);
	});
});

describe('static analysis', () => {
	test('containsStatusFunction', () => {
		expect(containsStatusFunction('always()')).toBe(true);
		expect(containsStatusFunction("ALWAYS() && yoal.ref == 'x'")).toBe(true);
		expect(containsStatusFunction('${{ !cancelled() }}')).toBe(true);
		expect(containsStatusFunction("yoal.ref == 'success()'")).toBe(false);
		expect(containsStatusFunction('contains(needs.*.result, 1)')).toBe(false);
		expect(() => containsStatusFunction('(')).toThrow(PipelineExpressionError);
	});

	test('expressionReferences', () => {
		expect(expressionReferences("github.ref == 'x' && YOAL.sha && matrix.os || secrets.TOKEN")).toEqual(['yoal', 'matrix', 'secrets']);
		expect(expressionReferences("format('{0}', Steps.a.outputs.b, needs.x.result)")).toEqual(['steps', 'needs']);
		expect(expressionReferences("'matrix.os'")).toEqual([]);
		expect(expressionReferences('env[vars.name]')).toEqual(['env', 'vars']);
	});

	test('expressionFunctions', () => {
		expect(expressionFunctions("hashFiles('a') && Success()")).toEqual(['hashfiles', 'success']);
	});
});

describe('fuzz', () => {
	/** Small deterministic PRNG (mulberry32) so failures reproduce. */
	function rng(seed: number): () => number {
		let a = seed;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const pieces = [
		'yoal', 'github', 'env', 'matrix', 'needs', 'steps', 'job', '.', '.*', '[', ']', '[*]', '(', ')', ',', '!', '==', '!=',
		'<', '<=', '>', '>=', '&&', '||', "'a'", "'it''s'", "''", '1', '-2.5', '0x1f', '1e3', 'NaN', 'null', 'true', 'false',
		'contains(', 'format(', "format('{0}'", 'join(', 'toJSON(', 'fromJSON(', "fromJSON('[1,{\"a\":2}]')", 'success()',
		'always()', 'startsWith(', 'endsWith(', 'hashFiles(', 'fruits', 'name', 'event', ' ', '}}', '${{', '{', '#', "'",
	];

	test('random token soup only ever throws PipelineExpressionError', () => {
		const random = rng(42);
		let evaluated = 0;
		for (let i = 0; i < 5000; i++) {
			const length = 1 + Math.floor(random() * 14);
			let expr = '';
			for (let j = 0; j < length; j++) expr += pieces[Math.floor(random() * pieces.length)];
			for (const run of [
				() => evaluateExpression(expr, ctx, { hashFiles: () => 'h' }),
				() => interpolate(`x ${expr} \${{ ${expr} }}`, ctx),
				() => evaluateCondition(expr, ctx, { status: { failed: random() < 0.5, cancelled: false } }),
			]) {
				try {
					run();
					evaluated++;
				} catch (error) {
					if (!(error instanceof PipelineExpressionError)) throw new Error(`Non-expression error for ${JSON.stringify(expr)}: ${String(error)}`);
				}
			}
		}
		expect(evaluated).toBeGreaterThan(100);
	});

	test('random characters only ever throw PipelineExpressionError', () => {
		const random = rng(7);
		const alphabet = "abcxyz019._-*()[]{}'\"!=<>&|,$# \n\t\\";
		for (let i = 0; i < 5000; i++) {
			const length = Math.floor(random() * 30);
			let expr = '';
			for (let j = 0; j < length; j++) expr += alphabet[Math.floor(random() * alphabet.length)];
			try {
				evaluateExpression(expr, ctx);
				interpolate(expr, ctx);
			} catch (error) {
				if (!(error instanceof PipelineExpressionError)) throw new Error(`Non-expression error for ${JSON.stringify(expr)}: ${String(error)}`);
			}
		}
	});

	test('deep but legal chains evaluate', () => {
		expect(ev(Array.from({ length: 2000 }, () => '1').join(' == '))).toBe(true);
		expect(ev(`yoal${'.a'.repeat(3000)}`)).toBe(null);
	});
});
