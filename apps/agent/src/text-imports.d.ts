/** `import x from '…/VERSION' with { type: 'text' }` (Bun text loader). */
declare module '*/VERSION' {
	const text: string;
	export default text;
}

/** `import kvWorker from '…/packages/function-bindings/src/kv.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/kv.js' {
	const text: string;
	export default text;
}

/** `import cacheWorker from '…/packages/function-bindings/src/cache.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/cache.js' {
	const text: string;
	export default text;
}

/** `import r2Worker from '…/packages/function-bindings/src/r2.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/r2.js' {
	const text: string;
	export default text;
}

/** `import assetsWorker from '…/packages/function-bindings/src/assets.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/assets.js' {
	const text: string;
	export default text;
}

/** `import queueWorker from '…/packages/function-bindings/src/queue.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/queue.js' {
	const text: string;
	export default text;
}

/** `import analyticsWorker from '…/packages/function-bindings/src/analytics.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/analytics.js' {
	const text: string;
	export default text;
}

/** `import tailWorker from '…/packages/function-bindings/src/tail.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/tail.js' {
	const text: string;
	export default text;
}

/** `import d1Worker from '…/packages/function-bindings/src/d1.js' with { type: 'text' }` (Bun). */
declare module '*/function-bindings/src/d1.js' {
	const text: string;
	export default text;
}
