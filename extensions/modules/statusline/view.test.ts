import { expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { migrateStatusline, STATUSLINE_DEFAULT_ORDER, type StatuslineConfig } from "../config.ts";
import type { StatuslineTheme } from "./types.ts";
import { renderStatusRow } from "./view.ts";

const arrow = String.fromCharCode(0xe0b1);
const theme: StatuslineTheme = {
	fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
	bg: (_color, text) => `\x1b[48;5;16m${text}\x1b[49m`,
};

test("renderStatusRow bands the row with spaced separators padded to full width", () => {
	const row = renderStatusRow(["a", "b", "c"], 20, theme)[0] ?? "";
	expect(row.startsWith("\x1b[48;5;16m")).toBe(true);
	expect(row.endsWith("\x1b[49m")).toBe(true);
	expect(visibleWidth(row)).toBe(20);
	expect(row).toContain(` a \x1b[36m${arrow}\x1b[39m b \x1b[36m${arrow}\x1b[39m c `);
});

test("renderStatusRow drops empty segments, collapses when everything is empty or width is zero", () => {
	expect(renderStatusRow(["a", "", "c"], 20, theme)[0]).toContain(` a \x1b[36m${arrow}\x1b[39m c `);
	expect(renderStatusRow(["a"], 0, theme)).toEqual([]);
});

test("renderStatusRow truncates overflowing segments to the widget width", () => {
	const row = renderStatusRow(["abcdefghijklmnop"], 10, theme)[0] ?? "";
	expect(visibleWidth(row)).toBe(10);
});

test("migrateStatusline passes an already-migrated block through", () => {
	const input = {
		prefix: "state",
		order: ["indicator", "kube"],
		components: { kube: { color: "success" } },
	} satisfies StatuslineConfig;
	const migrated = migrateStatusline(input);
	expect(migrated).toEqual(input);
});

test("migrateStatusline converts legacy segments into order and per-component blocks", () => {
	const migrated = migrateStatusline({
		segments: [
			{ name: "contextLimit" },
			{ name: "budget", color: "statusLineSpend" },
			{ name: "sessionCost", color: "accent" },
			{ name: "aws", enabled: false },
		],
	});
	expect(migrated?.order).toEqual(["contextLimit", "budget", "sessionCost", "aws"]);
	expect(migrated?.components).toEqual({
		contextLimit: {},
		budget: { color: "statusLineSpend" },
		sessionCost: { color: "accent" },
		aws: { enabled: false },
	});
});

test("migrateStatusline merges legacy names into an existing order without duplicates", () => {
	const migrated = migrateStatusline({
		order: ["indicator", "kube"],
		components: { kube: {} },
		segments: [{ name: "kube", color: "success" }, { name: "aws" }],
	});
	expect(migrated?.order).toEqual(["indicator", "kube", "aws"]);
	expect(migrated?.components).toEqual({ kube: { color: "success" }, aws: {} });
});

test("migrateStatusline ignores unknown legacy segment names", () => {
	const migrated = migrateStatusline({ segments: [{ name: "bogus", color: "accent" }, { name: "aws" }] });
	expect(migrated?.order).toEqual(["aws"]);
});

test("migrateStatusline returns undefined for absent, non-object, and empty values", () => {
	expect(migrateStatusline(undefined)).toBeUndefined();
	expect(migrateStatusline("nope")).toBeUndefined();
	expect(migrateStatusline([])).toBeUndefined();
	expect(migrateStatusline({})).toBeUndefined();
});

test("default order covers every documented component", () => {
	expect(STATUSLINE_DEFAULT_ORDER).toEqual(["indicator", "model", "contextLimit", "budget", "sessionCost", "aws", "kube"]);
});
