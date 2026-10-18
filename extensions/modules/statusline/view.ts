/**
 * Statusline row renderer — pure: colored segments in, one banded row out.
 *
 * All formatting and coloring happens in components; view.ts joins them with the native status-line
 * look (statusLineBg band ending in a powerline end cap, spaced powerline-thin separators), clamped to width.
 */
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { StatuslineTheme } from "./types.ts";

// theme.sep.powerlineThinLeft under the nerd symbol preset; same glyph the native footer joins with.
const SEPARATOR = String.fromCharCode(0xe0b1);
// theme.sep.powerlineLeft — the solid taper the native band closes with.
const END_CAP = String.fromCharCode(0xe0b0);

export function renderStatusRow(segments: string[], width: number, theme: StatuslineTheme): string[] {
	const visible = segments.filter((segment) => segment.length > 0);
	if (visible.length === 0 || width <= 0) return [];
	const cap = endCap(theme);
	const sep = theme.fg("statusLineSep", SEPARATOR);
	const line = truncateToWidth(` ${visible.join(` ${sep} `)} `, width - (cap ? 1 : 0));
	return [theme.bg("statusLineBg", line) + cap];
}

/**
 * Native end cap: the band fill re-issued as foreground (`useBgAsFg`) so the glyph tapers into the
 * terminal background. Dropped when the fill is transparent (empty or the default-bg sentinel).
 */
function endCap(theme: StatuslineTheme): string {
	const bgAnsi = theme.getBgAnsi("statusLineBg");
	if (!bgAnsi || bgAnsi === "\x1b[49m") return "";
	return `${bgAnsi.replace("\x1b[48;", "\x1b[38;")}${END_CAP}\x1b[39m`;
}
