/**
 * Statusline row renderer — pure: colored segments in, one banded row out.
 *
 * All formatting and coloring happens in components; view.ts joins them with the native status-line
 * look (statusLineBg band, spaced powerline-thin separators) and clamps to the widget width.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { StatuslineTheme } from "./types.ts";

// theme.sep.powerlineThinLeft under the nerd symbol preset; same glyph the native footer joins with.
const SEPARATOR = String.fromCharCode(0xe0b1);

export function renderStatusRow(segments: string[], width: number, theme: StatuslineTheme): string[] {
	const visible = segments.filter((segment) => segment.length > 0);
	if (visible.length === 0 || width <= 0) return [];
	const sep = theme.fg("statusLineSep", SEPARATOR);
	const line = truncateToWidth(` ${visible.join(` ${sep} `)} `, width);
	const fill = Math.max(0, width - visibleWidth(line));
	return [theme.bg("statusLineBg", `${line}${" ".repeat(fill)}`)];
}
