/**
 * A compact, human-readable label for a session's User-Agent.
 *
 * This is presentation only: it helps someone recognise their own sessions in the account
 * settings page. It is never used for authorization or parsing security decisions.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
	const ua = userAgent?.trim();
	if (!ua) return 'Unknown device';

	if (
		/\b(?:curl|wget|python-requests|httpclient)\b/i.test(ua) ||
		/(?:bot|crawler|spider|headless)/i.test(ua)
	) {
		return 'Automated client';
	}

	const browser = detectBrowser(ua);
	const os = detectOs(ua);
	if (!browser && !os) return 'Unknown device';
	if (browser && os) return `${browser} on ${os}`;
	return browser ?? os ?? 'Unknown device';
}

function detectBrowser(ua: string): string | undefined {
	// Order matters: Edge and Opera also contain Chrome; Chrome also contains Safari.
	if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return 'Edge';
	if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
	if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
	if (/\bCriOS\//.test(ua)) return 'Chrome';
	if (/\bChrome\/|\bChromium\//.test(ua)) return 'Chrome';
	if (/\bSafari\/|\bVersion\//.test(ua)) return 'Safari';
	return undefined;
}

function detectOs(ua: string): string | undefined {
	if (/\bWindows NT\b|\bWindows Phone\b/.test(ua)) return 'Windows';
	if (/\biPhone\b/.test(ua)) return 'iPhone';
	if (/\biPad\b/.test(ua)) return 'iPad';
	if (/\bAndroid\b/.test(ua)) return 'Android';
	if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
	if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
	if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux';
	return undefined;
}
