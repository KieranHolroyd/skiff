import { cubicOut, quartOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

const DURATION = 380;

/**
 * Sidebar pane swap, as a navigation stack. `dir` 1 drills in: the deeper pane slides in from the
 * right over the current one, which drifts left and dims. -1 backs out: the deeper pane slides
 * off to the right, uncovering the shallower one as it drifts back in. 0 swaps two panes at the
 * same depth with a crossfade.
 *
 * Both panes are opaque, and the deeper one is always on top, so only one menu is ever readable.
 * Svelte eases outros forwards too (t = 1 − easing(progress)), so both panes share one curve.
 */
export function pane(
	_node: Element,
	{ dir }: { dir: number },
	options: { direction: 'in' | 'out' | 'both' }
): TransitionConfig {
	const reduce =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const entering = options.direction !== 'out';
	// The leaving pane must not take clicks meant for the one arriving.
	const inert = entering ? '' : ' pointer-events: none;';

	if (reduce || dir === 0) {
		return {
			duration: reduce ? 150 : 200,
			easing: cubicOut,
			css: (t) => `opacity: ${t}; z-index: ${entering ? 2 : 1};${inert}`
		};
	}

	// The deeper pane is the one arriving on a drill-in and the one leaving on a back-out.
	const front = dir > 0 === entering;
	return {
		duration: DURATION,
		easing: quartOut,
		css: (t, u) =>
			front
				? // Slides fully across, stays solid, casts a soft edge onto the pane beneath.
					`transform: translate3d(${u * 100}%, 0, 0); z-index: 2;` +
					` box-shadow: -12px 0 24px -16px rgb(0 0 0 / ${(0.35 * t).toFixed(3)});${inert}`
				: // Parallax underneath: a third of the distance, dimmed while covered.
					`transform: translate3d(${-u * 30}%, 0, 0); z-index: 1;` +
					` opacity: ${(0.25 + 0.75 * t).toFixed(3)};${inert}`
	};
}
