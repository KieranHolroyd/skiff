// A plain Node.js server with no Skiff-specific code (D125). It listens on PORT like any Node
// app; on Skiff, with socket activation on, the helper's preload moves this listen() onto the
// socket systemd passes, so the app can scale to zero and cold-start on the next request.
import { createServer } from 'node:http';

const startedAt = new Date().toISOString();
let requests = 0;

const server = createServer((request, response) => {
	requests += 1;
	if (request.url === '/health') {
		response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
		return;
	}
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			hello: 'from Node.js',
			node: process.version,
			startedAt,
			requests,
		}),
	);
});

server.listen(Number(process.env.PORT ?? 3000), () => {
	console.log(JSON.stringify({ event: 'listening', address: server.address() }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
