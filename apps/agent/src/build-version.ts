// Repository-root VERSION, embedded at build time (`bun build --compile` inlines text imports), so a
// binary always reports the release it was built from, never a value left behind in an env file.
import raw from '../../../VERSION' with { type: 'text' };

export const BUILD_VERSION: string = raw.trim();
