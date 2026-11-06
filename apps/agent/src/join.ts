import { join } from 'node:path';
import { BUILD_VERSION } from './build-version.ts';
import { nodeJoinSchema, type NodeJoin } from '@skiff/contracts';
import { atomicWriteFile } from './state.ts';

/**
 * `skiff-agent join <controlUrl> --token … --name …` exchanges a single-use join token for a node
 * identity, writes `${dataDir}/node.json` and prints the systemd EnvironmentFile lines.
 */

export const JOIN_USAGE = `Usage: skiff-agent join <controlUrl> --token <joinToken> --name <name> [--data-dir <dir>] [--public-address <address>]`;

export class JoinError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JoinError';
	}
}

export interface JoinOptions {
	controlUrl: string;
	token: string;
	name: string;
	dataDir: string;
	version: string;
	publicAddress?: string;
}

export interface JoinedNode {
	controlUrl: string;
	nodeId: string;
	token: string;
	mode: 'edge' | 'worker';
	joinedAt: string;
}

type Env = Record<string, string | undefined>;
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function nodeFilePath(dataDir: string): string {
	return join(dataDir, 'node.json');
}

function normalizeControlUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new JoinError(`Invalid control URL: ${value}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new JoinError('Control URL must be http or https');
	return value.replace(/\/+$/, '');
}

function takeValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith('--'))
		throw new JoinError(`${flag} requires a value\n${JOIN_USAGE}`);
	return value;
}

/** Parse the arguments after the `join` subcommand. */
export function parseJoinArgs(args: string[], env: Env = process.env): JoinOptions {
	const positionals: string[] = [];
	let token: string | undefined;
	let name: string | undefined;
	let publicAddress: string | undefined;
	let dataDir = env.SKIFF_DATA_DIR?.trim() || '/var/lib/skiff-agent';

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		const equals = arg.indexOf('=');
		const flag = equals > 0 ? arg.slice(0, equals) : arg;

		if (flag === '--token' || flag === '--name' || flag === '--data-dir' || flag === '--public-address') {
			const value = equals > 0 ? arg.slice(equals + 1) : takeValue(args, index, flag);
			if (equals < 0) index += 1;
			if (!value) throw new JoinError(`${flag} requires a value\n${JOIN_USAGE}`);
			if (flag === '--token') token = value;
			else if (flag === '--name') name = value;
			else if (flag === '--data-dir') dataDir = value;
			else publicAddress = value;
			continue;
		}
		if (arg === '--help' || arg === '-h')
			throw new JoinError(JOIN_USAGE);
		if (arg.startsWith('--')) throw new JoinError(`Unknown option ${arg}\n${JOIN_USAGE}`);
		positionals.push(arg);
	}

	if (positionals.length !== 1) throw new JoinError(`Expected one control URL\n${JOIN_USAGE}`);
	if (!token) throw new JoinError(`--token is required\n${JOIN_USAGE}`);
	if (!name) throw new JoinError(`--name is required\n${JOIN_USAGE}`);
	if (token.length < 20) throw new JoinError('Join token must be at least 20 characters');
	if (name.length > 120) throw new JoinError('--name must be at most 120 characters');
	if (publicAddress && publicAddress.length > 253)
		throw new JoinError('--public-address must be at most 253 characters');

	return {
		controlUrl: normalizeControlUrl(positionals[0]!),
		token,
		name,
		dataDir: dataDir.replace(/\/+$/, '') || '/',
		version: env.SKIFF_AGENT_VERSION?.trim() || BUILD_VERSION,
		...(publicAddress ? { publicAddress } : {}),
	};
}

/** Exchange the join token and persist the node identity (atomic, mode 0600). */
export async function joinNode(options: JoinOptions, fetchImpl: FetchLike = fetch): Promise<JoinedNode> {
	const body: NodeJoin = {
		token: options.token,
		name: options.name,
		version: options.version,
		...(options.publicAddress ? { publicAddress: options.publicAddress } : {}),
	};
	const parsedBody = nodeJoinSchema.safeParse(body);
	if (!parsedBody.success)
		throw new JoinError(`Invalid join request: ${parsedBody.error.message}`);

	let response: Response;
	try {
		response = await fetchImpl(`${options.controlUrl}/api/agent/join`, {
			method: 'POST',
			signal: AbortSignal.timeout(30_000),
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(parsedBody.data),
		});
	} catch (error) {
		throw new JoinError(
			`Could not reach ${options.controlUrl}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const text = await response.text();
	if (!response.ok) {
		throw new JoinError(
			`Join failed (${response.status}): ${text.trim() || response.statusText || 'no response body'}`,
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new JoinError('Control plane returned invalid JSON');
	}
	if (typeof value !== 'object' || value === null) throw new JoinError('Control plane returned an invalid response');
	const record = value as Record<string, unknown>;
	if (typeof record.nodeId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(record.nodeId))
		throw new JoinError('Response has a missing or invalid nodeId');
	if (typeof record.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.token))
		throw new JoinError('Response has a missing or invalid token');
	const mode = record.mode === 'edge' || record.mode === 'worker' ? record.mode : null;
	if (!mode) throw new JoinError('Response has an invalid node mode');
	const controlUrl =
		typeof record.controlUrl === 'string' && record.controlUrl
			? normalizeControlUrl(record.controlUrl)
			: options.controlUrl;

	const joined: JoinedNode = {
		controlUrl,
		nodeId: record.nodeId,
		token: record.token,
		mode,
		joinedAt: new Date().toISOString(),
	};

	await atomicWriteFile(nodeFilePath(options.dataDir), `${JSON.stringify(joined)}\n`);
	return joined;
}

/** EnvironmentFile lines for `/etc/skiff/agent.env`. */
export function formatEnv(node: JoinedNode): string {
	return [
		`SKIFF_CONTROL_URL=${node.controlUrl}`,
		`SKIFF_NODE_ID=${node.nodeId}`,
		`SKIFF_NODE_TOKEN=${node.token}`,
		`SKIFF_NODE_MODE=${node.mode}`,
	].join('\n') + '\n';
}
