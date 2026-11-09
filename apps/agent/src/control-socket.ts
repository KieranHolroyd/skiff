/**
 * The edge agent shares a host with the control plane. With `YOAL_CONTROL_SOCKET` set it sends
 * every request for the control-plane origin (desired state, heartbeats, task results, release
 * downloads from presigned `/api/objects/` URLs) straight to the control plane's unix socket
 * instead of out through public DNS and back in through Caddy (D105).
 *
 * That is what makes a domain change safe: after the platform host changes, the agent can still
 * fetch the desired state that tells Caddy about the new host, even though the old Caddy config
 * does not route it yet and public DNS may not have caught up.
 *
 * The control plane sits behind Caddy in production and trusts `X-Forwarded-Proto/Host`
 * (PROTOCOL_HEADER/HOST_HEADER in its unit), so those are set to what the public URL would give.
 */

type Fetch = typeof fetch;

const SOCKET_ERRORS = new Set(['ENOENT', 'ECONNREFUSED', 'FailedToOpenSocket', 'ConnectionRefused']);

export function controlSocketFetch(base: Fetch, controlUrl: string, socket: string): Fetch {
	const control = new URL(controlUrl);
	const proto = control.protocol.replace(/:$/, '');

	const routed = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
		const request = input instanceof Request ? input : null;
		let url: URL;
		try {
			url = new URL(request ? request.url : String(input));
		} catch {
			return base(input, init);
		}
		if (url.origin !== control.origin) return base(input, init);

		const headers = new Headers(request?.headers);
		new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
		headers.set('x-forwarded-proto', proto);
		headers.set('x-forwarded-host', control.host);
		// Plain HTTP on the socket; the URL only supplies the path and the Host header.
		const target = `http://${control.host}${url.pathname}${url.search}`;
		const options = {
			method: init?.method ?? request?.method,
			body: init?.body ?? request?.body,
			signal: init?.signal ?? request?.signal,
			redirect: init?.redirect ?? request?.redirect,
			headers,
			unix: socket,
		} as RequestInit;
		try {
			return await base(target, options);
		} catch (error) {
			// No socket here (or the control plane is restarting): fall back to the network path.
			const code = (error as { code?: string }).code;
			if (code && SOCKET_ERRORS.has(code)) return base(input, init);
			throw error;
		}
	}) as Fetch;
	return Object.assign(routed, { preconnect: base.preconnect });
}
