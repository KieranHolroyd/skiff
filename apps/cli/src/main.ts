#!/usr/bin/env bun
/**
 * Skiff CLI. Published as the `skif` npm package and installed under two command names,
 * `skif` and `skiff` (D33), both pointing at this entrypoint.
 *
 * Commands (ROADMAP v1): login, deploy (presigned upload), status. Not implemented yet.
 */
import pkg from '../package.json' with { type: 'json' };

// Symlinked bins resolve to this file's path, so the invoked name isn't recoverable; use the canonical one.
const invokedAs = 'skif';
const [command] = process.argv.slice(2);

switch (command) {
	case undefined:
	case '--help':
	case '-h':
		console.log(`${invokedAs} ${pkg.version}\n\nUsage: ${invokedAs} <command>   (\`skiff\` works too)\n\nCommands:\n  login     Sign in to a Skiff platform (not implemented yet)\n  deploy    Deploy a directory (not implemented yet)\n  status    Show platform and project status (not implemented yet)\n  --version Print the version`);
		break;
	case '--version':
	case '-v':
		console.log(pkg.version);
		break;
	default:
		console.error(`${invokedAs}: '${command}' is not implemented yet`);
		process.exit(1);
}
