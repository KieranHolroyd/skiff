/** Types for nats.js (plain ESM so workerd can embed it unchanged). */

export interface StreamSocketLike {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close?(): void;
}

export interface NatsHeaders {
	status: number;
	description: string;
	get(name: string): string | undefined;
	entries(): Array<[string, string]>;
}

export interface NatsMessage {
	subject: string;
	sid: string;
	reply?: string;
	headers: NatsHeaders | null;
	data: Uint8Array;
}

export interface AckInfo {
	stream: string;
	consumer: string;
	delivered: number;
	streamSequence: number;
	timestampMs: number;
}

export interface PulledMessage {
	data: Uint8Array;
	headers: NatsHeaders | null;
	reply?: string;
	info: AckInfo | null;
}

export declare const QUEUE_MAX_MESSAGE_BYTES: number;
export declare const QUEUE_CONSUMER: string;
export declare const QUEUE_HEADERS: Readonly<{
	id: string;
	contentType: string;
	notBefore: string;
	timestamp: string;
	attempts: string;
}>;

export declare class NatsError extends Error {
	code: string;
	errCode?: number;
	status?: number;
	constructor(message: string, code?: string);
}

export declare class NatsConnection {
	info: Record<string, unknown> | null;
	inbox: string;
	closed: boolean;
	static connect(
		socket: StreamSocketLike,
		options?: { user?: string; pass?: string; name?: string; timeoutMs?: number },
	): Promise<NatsConnection>;
	publish(
		subject: string,
		data?: Uint8Array | ArrayBuffer | string | unknown,
		options?: { headers?: Record<string, string>; reply?: string },
	): Promise<void>;
	subscribe(subject: string, handler: (message: NatsMessage | null, error: Error | null) => void): string;
	unsubscribe(sid: string): void;
	request(
		subject: string,
		data?: Uint8Array | ArrayBuffer | string | unknown,
		options?: { headers?: Record<string, string>; timeoutMs?: number },
	): Promise<NatsMessage>;
	close(): Promise<void>;
}

export declare function queueStreamName(queue: string): string;
export declare function queueSubject(queue: string): string;
export declare function queueStreamConfig(queue: string): Record<string, unknown>;
export declare function queueConsumerConfig(queue: string, ackWaitMs: number): Record<string, unknown>;
export declare function encodeHeaders(headers: Record<string, string | undefined | null>): Uint8Array;
export declare function decodeHeaders(bytes: Uint8Array): NatsHeaders;
export declare function jsApi(connection: NatsConnection, api: string, body?: unknown, timeoutMs?: number): Promise<any>;
export declare function ensureQueueStream(connection: NatsConnection, queue: string): Promise<any>;
export declare function ensureQueueConsumer(connection: NatsConnection, queue: string, ackWaitMs: number): Promise<any>;
export declare function publishToQueue(
	connection: NatsConnection,
	queue: string,
	body: Uint8Array | string,
	headers: Record<string, string>,
	timeoutMs?: number,
): Promise<{ stream: string; seq: number; duplicate?: boolean }>;
export declare function queueBacklog(
	connection: NatsConnection,
	queue: string,
): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp: number }>;
export declare function ackInfo(reply: string | undefined): AckInfo | null;
export declare function pullQueue(
	connection: NatsConnection,
	queue: string,
	options: { batch?: number; expiresMs?: number },
): Promise<PulledMessage[]>;
export declare function ackMessage(connection: NatsConnection, message: { reply?: string }): Promise<void>;
export declare function nakMessage(connection: NatsConnection, message: { reply?: string }, delayMs?: number): Promise<void>;
export declare function termMessage(connection: NatsConnection, message: { reply?: string }): Promise<void>;
