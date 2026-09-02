import { expect, test } from "bun:test";
import { migrateStatusline, STATUSLINE_DEFAULT_ORDER, type StatuslineConfig } from "../config.ts";
import { renderStatusRow } from "./view.ts";

test("renderStatusRow joins non-empty segments and truncates to width", () => {
	const arrow = String.fromCharCode(0xe0b1);
	expect(renderStatusRow(["a", "b", "c"], 80)).toEqual([`a${arrow}b${arrow}c`]);
	expect(renderStatusRow(["a", "", "c"], 80)).toEqual([`a${arrow}c`]);
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
	expect(STATUSLINE_DEFAULT_ORDER).toEqual(["indicator", "contextLimit", "budget", "sessionCost", "aws", "kube"]);
});
