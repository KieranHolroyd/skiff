import { describe, expect, test } from 'bun:test';
import { assertComposeSupported, parseComposeDocument, splitCommand } from './compose.ts';

const YAML = `
services:
  web:
    image: ghcr.io/acme/web:1.2.3
    command: ["node", "server.js"]
    ports: ["3000"]
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://db/app
    depends_on: [db]
    volumes:
      - uploads:/app/uploads
  db:
    image: postgres:17-alpine
    ports:
      - "5432"
    environment:
      POSTGRES_PASSWORD: example
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
volumes:
  uploads:
x-yoal:
  routes:
    - service: web
      port: 3000
      primary: true
    - service: web
      port: 3000
      host: api.examplecloud.com
`;

describe('compose parser', () => {
	test('maps the supported subset into a strict stack', () => {
		const parsed = parseComposeDocument(YAML);
		expect(parsed.unsupported).toEqual([]);
		expect(parsed.spec.services.map((service) => service.name)).toEqual(['web', 'db']);
		expect(parsed.spec.services[0]).toMatchObject({
			image: 'ghcr.io/acme/web:1.2.3',
			command: ['node', 'server.js'],
			ports: [3000],
			dependsOn: ['db'],
			env: { NODE_ENV: 'production' },
			volumes: [{ name: 'uploads', mountPath: '/app/uploads', readOnly: false }],
		});
		expect(parsed.spec.volumes).toEqual([{ name: 'uploads' }]);
		expect(parsed.spec.routes).toEqual([
			{ service: 'web', port: 3000, healthPath: '/', primary: true },
			{ service: 'web', port: 3000, host: 'api.examplecloud.com', healthPath: '/', primary: false },
		]);
	});

	test('derives one primary route when the file has none', () => {
		const parsed = parseComposeDocument(`
services:
  web:
    image: nginx:1.27
    ports: ["8080"]
`);
		expect(parsed.spec.routes).toEqual([{ service: 'web', port: 8080, healthPath: '/', primary: true }]);
		expect(parsed.warnings.some((warning) => warning.path === 'x-yoal.routes')).toBe(true);
	});

	test('refuses host bind mounts and build without applying anything', () => {
		const parsed = parseComposeDocument(`
services:
  web:
    image: nginx:1.27
    volumes:
      - ./site:/usr/share/nginx/html:ro
  build:
    build: .
`);
		expect(parsed.unsupported.map((entry) => entry.path)).toEqual([
			'services.web.volumes[0]',
			'services.build.build',
		]);
		expect(() => assertComposeSupported(parsed)).toThrow(/Bind mounts from the host are not supported/);
		expect(() => assertComposeSupported(parsed)).toThrow(/`build` is not supported/);
	});

	test('refuses privileged containers, host networking and capabilities', () => {
		const parsed = parseComposeDocument(`
services:
  root:
    image: alpine:3.20
    privileged: true
    network_mode: host
    cap_add: [SYS_ADMIN]
`);
		expect(parsed.unsupported.map((entry) => entry.path)).toEqual([
			'services.root.privileged',
			'services.root.network_mode',
			'services.root.cap_add',
		]);
	});

	test('rejects a route to a port the service does not declare', () => {
		expect(() =>
			parseComposeDocument(`
services:
  web:
    image: nginx:1.27
    ports: ["80"]
x-yoal:
  routes:
    - service: web
      port: 8080
`),
		).toThrow(/does not declare container port 8080/);
	});

	test('rejects dependency cycles and unknown services', () => {
		expect(() =>
			parseComposeDocument(`
services:
  a:
    image: nginx:1.27
    depends_on: [b]
  b:
    image: nginx:1.27
    depends_on: [a]
`),
		).toThrow(/cycle/);
		expect(() =>
			parseComposeDocument(`
services:
  a:
    image: nginx:1.27
    depends_on: [missing]
`),
		).toThrow(/Unknown service "missing"/);
	});

	test('reads resource limits and a compose env list', () => {
		const parsed = parseComposeDocument(`
services:
  api:
    image: node:22-alpine
    environment:
      - PORT=3000
      - NO_VALUE
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: 2
`);
		expect(parsed.spec.services[0]).toMatchObject({ memoryMb: 1024, cpus: 2, env: { PORT: '3000' } });
		expect(parsed.warnings.some((warning) => warning.message.includes('NO_VALUE'))).toBe(true);
	});

	test('accepts JSON input and ignores presentational keys with a warning', () => {
		const parsed = parseComposeDocument(
			JSON.stringify({
				services: {
					web: { image: 'nginx:1.27', container_name: 'web', restart: 'unless-stopped' },
				},
			}),
		);
		expect(parsed.spec.services[0]?.name).toBe('web');
		expect(parsed.warnings.map((warning) => warning.path)).toEqual([
			'services.web.container_name',
			'services.web.restart',
		]);
	});

	test('splitCommand keeps quotes and rejects operators as literals', () => {
		expect(splitCommand(`sh -c "echo hi"`)).toEqual(['sh', '-c', 'echo hi']);
		expect(splitCommand('node server.js')).toEqual(['node', 'server.js']);
		expect(() => splitCommand(`sh -c "unterminated`)).toThrow(/unterminated quote/);
	});

	test('rejects a file without services and malformed YAML', () => {
		expect(() => parseComposeDocument('version: "3"\n')).toThrow(/at least one service/);
		expect(() => parseComposeDocument('a: [unclosed')).toThrow(/not valid YAML or JSON/);
		expect(() => parseComposeDocument('   ')).toThrow(/empty/);
	});
});
