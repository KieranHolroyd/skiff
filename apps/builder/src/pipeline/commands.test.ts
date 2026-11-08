import { describe, expect, test } from 'bun:test';
import { FileCommandError, WorkflowCommandProcessor, parseKeyValueFile, parsePathFile, parseWorkflowCommand } from './commands.ts';

describe('file commands', () => {
	test('parses name=value lines; later wins; values may contain =', () => {
		expect(parseKeyValueFile('a=1\nb=x=y\n\na=2\n')).toEqual({ a: '2', b: 'x=y' });
		expect(parseKeyValueFile('empty=\n')).toEqual({ empty: '' });
		expect(parseKeyValueFile('')).toEqual({});
	});

	test('parses heredocs, including blank lines and CRLF', () => {
		const content = 'json<<EOF\n{\n  "a": 1\n\n}\nEOF\nnext=ok\nkey<<ghadelimiter_1\r\nline1\r\nline2\r\nghadelimiter_1\r\n';
		expect(parseKeyValueFile(content)).toEqual({ json: '{\n  "a": 1\n\n}', next: 'ok', key: 'line1\nline2' });
	});

	test('the first separator decides between = and <<', () => {
		expect(parseKeyValueFile('a=b<<c\n')).toEqual({ a: 'b<<c' });
		expect(parseKeyValueFile('a<<E=\nv\nE=\n')).toEqual({ a: 'v' });
	});

	test('rejects malformed content like GitHub', () => {
		expect(() => parseKeyValueFile('novalue\n')).toThrow(FileCommandError);
		expect(() => parseKeyValueFile('=x\n')).toThrow(FileCommandError);
		expect(() => parseKeyValueFile('a<<EOF\nnever closed\n')).toThrow(/Matching delimiter/);
		expect(() => parseKeyValueFile('a<<\n')).toThrow(FileCommandError);
	});

	test('path files are one directory per line', () => {
		expect(parsePathFile('/opt/a/bin\n\n  /opt/b/bin  \n')).toEqual(['/opt/a/bin', '/opt/b/bin']);
	});
});

describe('workflow commands', () => {
	test('parses commands with properties and escaped data', () => {
		expect(parseWorkflowCommand('::error file=app.js,line=10%2C2,title=A%3AB::Bad%0Athing 100%25')).toEqual({
			command: 'error',
			properties: { file: 'app.js', line: '10,2', title: 'A:B' },
			data: 'Bad\nthing 100%',
		});
		expect(parseWorkflowCommand('plain text')).toBeNull();
		expect(parseWorkflowCommand('::not closed')).toBeNull();
	});

	test('add-mask and set-output are consumed; group/error stay', () => {
		const processor = new WorkflowCommandProcessor();
		expect(processor.process('::add-mask::s3cret')).toEqual({ line: null, effect: { kind: 'mask', value: 's3cret' } });
		expect(processor.process('::set-output name=x::v')).toEqual({ line: null, effect: { kind: 'output', name: 'x', value: 'v' } });
		expect(processor.process('::group::Install')).toEqual({ line: '::group::Install', effect: null });
		expect(processor.process('::warning file=a::careful')).toEqual({ line: '::warning file=a::careful', effect: null });
		expect(processor.process('::set-env name=A::b').effect?.kind).toBe('warning');
	});

	test('stop-commands suspends processing until the token', () => {
		const processor = new WorkflowCommandProcessor();
		expect(processor.process('::stop-commands::pause-token').line).toBeNull();
		expect(processor.process('::add-mask::notmasked')).toEqual({ line: '::add-mask::notmasked', effect: null });
		expect(processor.process('::pause-token::').line).toBeNull();
		expect(processor.process('::add-mask::now').effect).toEqual({ kind: 'mask', value: 'now' });
	});
});
