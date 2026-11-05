/**
 * Shared presentation for TanStack Charts. Colours, fonts and the tooltip surface come from the
 * dashboard theme via the `.ts-chart-host` tokens in `routes/layout.css`; this module holds the
 * pieces that have to live in chart definitions.
 */

/** Dashed horizontal grid, matching the dashboard's hairline borders. */
export const CHART_GRID = { strokeDasharray: '3 5', strokeOpacity: 0.18 } as const;

/** Extra class on the built-in tooltip (styled in `routes/layout.css`). */
export const CHART_TOOLTIP_CLASS = 'skiff-chart-tooltip';

/** Clock labels for a UTC time axis; hourly data also shows the date. */
export function utcTimeFormat(interval: '1m' | '1h'): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		day: interval === '1h' ? '2-digit' : undefined,
		month: interval === '1h' ? 'short' : undefined,
		timeZone: 'UTC'
	});
}
