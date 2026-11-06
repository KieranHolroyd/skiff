/** `import x from '…/VERSION' with { type: 'text' }` (Bun text loader). */
declare module '*/VERSION' {
	const text: string;
	export default text;
}
