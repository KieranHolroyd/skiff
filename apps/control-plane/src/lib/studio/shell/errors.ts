import { StudioCallError } from '../client.js';

/** A studio failure in words, by the protocol's stable error code (plan 22). */
export interface StudioErrorInfo {
	code: string;
	title: string;
	message: string;
	/** The session is gone: offer to open it again. */
	reopen: boolean;
}

export function describeStudioError(caught: unknown): StudioErrorInfo {
	const message = caught instanceof Error ? caught.message : 'The studio request failed.';
	if (!(caught instanceof StudioCallError))
		return { code: 'internal', title: 'Something went wrong', message, reopen: false };
	switch (caught.code) {
		case 'session_expired':
			return {
				code: caught.code,
				title: 'Session expired',
				message: 'The studio session ended after being idle. Open it again to carry on.',
				reopen: true
			};
		case 'unknown_session':
			return {
				code: caught.code,
				title: 'Session closed',
				message: 'This studio session is no longer open. Open it again to carry on.',
				reopen: true
			};
		case 'read_only':
			return {
				code: caught.code,
				title: 'Read-only session',
				message: 'This session is read-only. Enable writes in the header to change data.',
				reopen: false
			};
		case 'conflict':
			return {
				code: caught.code,
				title: 'Changed since you loaded it',
				message: `${message} Nothing was applied; reload the rows and try again.`,
				reopen: false
			};
		case 'busy':
			return { code: caught.code, title: 'Session busy', message: 'Another query is still running in this session. Wait for it or stop it, then try again.', reopen: false };
		case 'timeout':
			return { code: caught.code, title: 'Timed out', message, reopen: false };
		case 'cancelled':
			return { code: caught.code, title: 'Cancelled', message: 'The request was cancelled.', reopen: false };
		case 'forbidden':
		case 'unauthorized':
			return { code: caught.code, title: 'Not allowed', message, reopen: false };
		case 'studio_unavailable':
		case 'studio_restarted':
			return {
				code: caught.code,
				title: 'Studio unavailable',
				message: 'The studio on the node is not answering right now. Try again in a moment.',
				reopen: false
			};
		case 'network':
			return { code: caught.code, title: 'Network error', message, reopen: false };
		case 'unsupported':
			return { code: caught.code, title: 'Not supported', message, reopen: false };
		default:
			return { code: caught.code, title: 'The studio request failed', message, reopen: false };
	}
}

/** "4:05" or "1:02:03" until the session expires. */
export function countdown(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, '0');
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
