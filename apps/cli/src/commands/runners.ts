import { UsageError } from '../errors.ts';
import { pruneCommand } from './prune.ts';

/**
 * GitHub Actions runners (docs/RUNNERS.md). Today the only command is prune: registrations for a
 * deleted project, a removed runner or a replica below the pool size are left behind when a node
 * disappears, and GitHub keeps them until they are removed.
 */

const usage = `Usage: yoal runners <command> [options]

Commands:
  prune                                Delete stale runner registrations (dry run by default)

A registration is stale when its project or workload is gone, the workload no longer runs a
runner pool, or its replica is below the current pool size. Registrations newer than the
retention window (Settings → Retention & defaults) are always kept.

Options:
      --older-than <days>              Override the retention window
      --apply                          Delete what the scan found (asks first unless --plan or --yes)
      --plan <op_id>                   Apply an existing scan instead of scanning again
  -y, --yes                            Don't ask for confirmation (required when stdin isn't a terminal)
      --json                           NDJSON progress events on stdout
  -h, --help                           Show this help`;

export async function runnersCommand(argv: string[]): Promise<void> {
	const [first, ...rest] = argv;
	if (!first || first === '-h' || first === '--help') {
		console.log(usage);
		return;
	}
	if (first === 'prune') return pruneCommand(['--only', 'runner_registrations', ...rest]);
	throw new UsageError(`Unknown runners command "${first}".\n\n${usage}`);
}
