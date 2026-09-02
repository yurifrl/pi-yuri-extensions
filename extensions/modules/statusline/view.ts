/**
 * Statusline row renderer — pure: colored segments in, one truncated row out.
 *
 * All formatting and coloring happens in components; view.ts only joins them and clamps to the widget width.
 */
import { truncateToWidth } from "@mariozechner/pi-tui";

export function renderStatusRow(segments: string[], width: number): string[] {
	const line = segments.filter((segment) => segment.length > 0).join("  ");
	if (!line) return [];
	return [truncateToWidth(line, Math.max(0, width))];
}
