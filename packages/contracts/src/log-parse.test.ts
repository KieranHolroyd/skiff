import { describe, expect, test } from 'bun:test';
import { parseLogLine } from './log-parse.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');

function parse(line: string, options: { now?: number; assumeOffsetMinutes?: number } = {}) {
	return parseLogLine(line, { now: NOW, ...options });
}

describe('parseLogLine', () => {
	test('leaves an unstructured line alone', () => {
		expect(parse('listening on :3000')).toEqual({
			message: 'listening on :3000',
			format: 'raw',
		});
	});

	test('parses JSON loggers with numeric and string levels', () => {
		expect(
			parse('{"level":30,"time":1720000000000,"pid":1,"msg":"request completed"}'),
		).toEqual({
			message: 'request completed',
			level: 'info',
			ts: 1720000000000,
			format: 'json',
		});

		expect(
			parse(
				'{"level":"error","message":"boom","timestamp":"2024-07-03T12:00:00.123Z"}',
			),
		).toEqual({
			message: 'boom',
			level: 'error',
			ts: Date.parse('2024-07-03T12:00:00.123Z'),
			format: 'json',
		});
	});

	test('parses ECS, CLEF, OTel and journald JSON fields', () => {
		expect(
			parse(
				'{"@timestamp":"2024-07-03T12:00:00Z","log.level":"err","message":"upstream refused"}',
			),
		).toMatchObject({ message: 'upstream refused', level: 'error' });

		expect(
			parse('{"@t":"2024-07-03T12:00:00Z","@l":"Warning","@m":"disk almost full"}'),
		).toMatchObject({ message: 'disk almost full', level: 'warn' });

		expect(
			parse(
				'{"timeUnixNano":"1720000000123000000","severityNumber":17,"body":{"stringValue":"otel boom"}}',
			),
		).toEqual({
			message: 'otel boom',
			level: 'error',
			ts: 1720000000123,
			format: 'json',
		});

		expect(
			parse('{"MESSAGE":"job failed","PRIORITY":"3","__REALTIME_TIMESTAMP":"1720000000123456"}'),
		).toEqual({
			message: 'job failed',
			level: 'error',
			ts: 1720000000123,
			format: 'json',
		});
	});

	test('unwraps Docker JSON-file records and parses the inner payload', () => {
		expect(
			parse(
				'{"log":"{\\"level\\":\\"error\\",\\"msg\\":\\"container broke\\"}\\n","stream":"stdout","time":"2024-07-03T12:00:00Z"}',
			),
		).toEqual({
			message: 'container broke',
			level: 'error',
			ts: Date.parse('2024-07-03T12:00:00Z'),
			format: 'docker',
		});
	});

	test('parses Kubernetes CRI lines and their inner content', () => {
		expect(
			parse(
				'2016-10-06T00:17:09.669794202Z stdout F {"level":"warn","msg":"slow request"}',
			),
		).toEqual({
			message: 'slow request',
			level: 'warn',
			ts: Date.parse('2016-10-06T00:17:09.669Z'),
			format: 'cri',
		});
	});

	test('parses logfmt including quoted values and Go slog text', () => {
		expect(
			parse('time=2024-07-03T12:00:00Z level=INFO msg="hello world" count=3'),
		).toEqual({
			message: 'hello world',
			level: 'info',
			ts: Date.parse('2024-07-03T12:00:00Z'),
			format: 'logfmt',
		});

		expect(parse('at=info method=GET path=/ host=example.com status=200')).toMatchObject({
			level: 'info',
			format: 'logfmt',
		});
	});

	test('does not mistake prose or query strings for logfmt', () => {
		expect(parse('the value a=b is not a log line')).toMatchObject({ format: 'raw' });
		expect(parse('https://example.com/?a=1&b=2')).toMatchObject({ format: 'raw' });
		expect(parse('user=alice action=login')).toMatchObject({ format: 'raw' });
	});

	test('parses RFC 5424 and RFC 3164 syslog', () => {
		expect(
			parse(
				'<34>1 2003-10-11T22:14:15.003Z host app - ID47 - level=info msg="inner message"',
			),
		).toEqual({
			message: 'inner message',
			level: 'info',
			ts: Date.parse('2003-10-11T22:14:15.003Z'),
			format: 'syslog',
		});

		expect(
			parse("<34>Oct 11 22:14:15 mymachine su: 'su root' failed for lonvick"),
		).toEqual({
			message: "'su root' failed for lonvick",
			level: 'error',
			ts: Date.parse('2026-10-11T22:14:15Z'),
			format: 'syslog',
		});
	});

	test('parses octet-counted syslog framing', () => {
		expect(
			parse(
				'264 <158>1 2024-04-26T16:58:32.943253+00:00 host heroku router - at=info method=GET path=/ status=200',
			),
		).toMatchObject({
			level: 'info',
			ts: Date.parse('2024-04-26T16:58:32.943Z'),
			format: 'syslog',
		});
	});

	test('parses Apache and Nginx access and error logs', () => {
		expect(
			parse(
				'127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 500 2326 "-" "Agent"',
			),
		).toEqual({
			message: 'GET /apache_pb.gif HTTP/1.0 500',
			level: 'error',
			ts: Date.parse('2000-10-10T13:55:36-07:00'),
			format: 'access-log',
		});

		expect(
			parse(
				'2023/10/11 14:32:52 [error] 123#123: *1 open() "/x" failed (2: No such file or directory)',
			),
		).toEqual({
			message: 'open() "/x" failed (2: No such file or directory)',
			level: 'error',
			ts: Date.parse('2023-10-11T14:32:52Z'),
			format: 'text',
		});

		expect(
			parse(
				'[Fri Sep 09 10:42:29.902022 2011] [core:error] [pid 1] AH00124: Request exceeded the limit',
			),
		).toEqual({
			message: 'AH00124: Request exceeded the limit',
			level: 'error',
			ts: Date.UTC(2011, 8, 9, 10, 42, 29, 902),
			format: 'text',
		});
	});

	test('parses Python, Java, Spring, .NET and plain text levels', () => {
		expect(parse('INFO:__main__:Started')).toEqual({
			message: 'Started',
			level: 'info',
			format: 'python',
		});

		expect(
			parse('2024-07-03 12:00:00,123 - app - WARNING - low disk'),
		).toEqual({
			message: 'low disk',
			level: 'warn',
			ts: Date.parse('2024-07-03T12:00:00.123Z'),
			format: 'python',
		});

		expect(
			parse('12:00:00.123 [main] INFO  com.example.App - hello'),
		).toEqual({
			message: 'hello',
			level: 'info',
			format: 'java',
		});

		expect(
			parse(
				'2026-10-20T04:46:06.745Z  INFO 11765 --- [myapp] [main] o.s.App : Starting',
			),
		).toEqual({
			message: 'Starting',
			level: 'info',
			ts: Date.parse('2026-10-20T04:46:06.745Z'),
			format: 'spring',
		});

		expect(parse('fail: Microsoft.Hosting.Lifetime[14]')).toMatchObject({
			level: 'error',
			format: 'dotnet',
		});

		expect(parse('[WARN] disk almost full')).toEqual({
			message: 'disk almost full',
			level: 'warn',
			format: 'text',
		});

		expect(
			parse('[skiff-agent 2026-11-03T23:23:02.419Z] INFO Listening on unix:///tmp/agent.sock'),
		).toEqual({
			message: 'Listening on unix:///tmp/agent.sock',
			level: 'info',
			ts: Date.parse('2026-11-03T23:23:02.419Z'),
			format: 'text',
		});

		expect(parse('2024-07-03T12:00:00Z INFO hello')).toEqual({
			message: 'hello',
			level: 'info',
			ts: Date.parse('2024-07-03T12:00:00Z'),
			format: 'text',
		});
	});

	test('normalises trace and fatal into the platform level vocabulary', () => {
		expect(parse('[trace] starting')).toMatchObject({ level: 'debug' });
		expect(parse('[FATAL] out of memory')).toMatchObject({ level: 'error' });
	});

	test('handles every numeric timestamp unit', () => {
		const expected = 1720000000123;
		for (const input of [
			'1720000000.123',
			'1720000000123',
			'1720000000123456',
			'1720000000123456789',
		]) {
			expect(parse(`ts=${input} level=info msg=hello`)).toMatchObject({
				ts: expected,
			});
		}
	});

	test('treats zone-less timestamps as UTC by default and honours an offset override', () => {
		expect(parse('2024-07-03T12:00:00 INFO hello')).toMatchObject({
			ts: Date.parse('2024-07-03T12:00:00Z'),
		});
		expect(
			parse('2024-07-03T12:00:00 INFO hello', { assumeOffsetMinutes: 60 }),
		).toMatchObject({
			ts: Date.parse('2024-07-03T11:00:00Z'),
		});
	});

	test('never throws and caps oversized messages', () => {
		for (const input of [
			'',
			'{"a":',
			'<999>',
			'a="unterminated',
			'[1,2',
			'\uFEFF2024-07-03T12:00:00Z INFO bom',
		]) {
			expect(() => parse(input)).not.toThrow();
		}

		const long = parse('x'.repeat(100_000));
		expect(long.format).toBe('raw');
		expect(long.message).toHaveLength(16_384);
	});

	test('leaves malformed JSON tagged as JSON without losing the line', () => {
		expect(parse('{"level":"info"')).toEqual({
			message: '{"level":"info"',
			format: 'json',
		});
	});
});
