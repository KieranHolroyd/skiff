export { MailServer, type MailServerConfig } from './server.ts';
export { classifyReply, classifyNetworkError, type ReplyOutcome } from './classify.ts';
export { resolveTargets, SystemResolver, type MailResolver, type MxRecord } from './dns.ts';
export { providerFor, Shaper, PROVIDERS } from './shaping.ts';
export { parseReport, dsnOutcome } from './reports.ts';
export { newMessageId } from './smtp.ts';
