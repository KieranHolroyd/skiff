import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, connect, type Server } from 'node:net';
import { ServiceForwarder } from './endpoints.ts';

const servers: Server[] = [];
const forwarders: ServiceForwarder[] = [];

async function echoServer(): Promise<number> {
	const server = createServer((socket) => socket.pipe(socket));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('no port');
	return address.port;
}

function readOnce(port: number, message: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port });
		socket.setEncoding('utf8');
		socket.on('error', reject);
		socket.on('connect', () => socket.write(message));
		socket.once('data', (data) => {
			socket.end();
			resolve(String(data));
		});
	});
}

afterEach(() => {
	for (const forwarder of forwarders.splice(0)) forwarder.close();
	for (const server of servers.splice(0)) server.close();
});

describe('ServiceForwarder', () => {
	test('forwards a consumer loopback port to the provider target', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge(
			[
				{
					id: 'sep_1',
					kind: 'database',
					serviceId: 'db_1',
					localPort: 21111,
					upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: target },
					tlsFingerprint: null,
				},
			],
			[],
		);
		await Bun.sleep(50);
		expect(await readOnce(21111, 'hello')).toBe('hello');
	});

	test('provider listener forwards an overlay port to loopback', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		forwarder.converge([], [
			{ id: 'svc_1', listenAddress: '127.0.0.1', listenPort: 21112, targetPort: target, allowedClientFingerprints: [] },
		]);
		await Bun.sleep(50);
		expect(await readOnce(21112, 'world')).toBe('world');
	});

	test('removes listeners that disappear from desired state', async () => {
		const target = await echoServer();
		const forwarder = new ServiceForwarder();
		forwarders.push(forwarder);
		const endpoint = {
			id: 'sep_2',
			kind: 'database' as const,
			serviceId: 'db_2',
			localPort: 21113,
			upstream: { nodeId: 'nod_b', address: '127.0.0.1', port: target },
			tlsFingerprint: null,
		};
		forwarder.converge([endpoint], []);
		await Bun.sleep(50);
		expect(await readOnce(21113, 'x')).toBe('x');
		forwarder.converge([], []);
		await Bun.sleep(50);
		await expect(readOnce(21113, 'x')).rejects.toBeTruthy();
	});
});
