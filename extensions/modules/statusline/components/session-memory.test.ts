/**
 * sessionMemory component: renders the process RSS with a memory icon; config validation.
 * The value comes from a real in-process sample taken at start, so the render check asserts the
 * shape (`󰍛 <n>M` / `󰍛 <n>.<n>G`), not a specific number.
 */
import { describe, expect, test } from "bun:test";
import { getComponent } from "../registry.ts";
import type { ComponentHost, StatuslineTheme } from "../types.ts";
import "./session-memory.ts";

const theme: StatuslineTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	getBgAnsi: () => "",
};

const host: ComponentHost = {
	pi: {} as never,
	ctx: () => undefined,
	redraw: () => {},
	setStatus: () => {},
	aggregate: () => ({ working: false, refreshing: false, attention: false }),
};

describe("sessionMemory component", () => {
	test("renders the sampled process memory in MB or GB", () => {
		const component = getComponent("sessionMemory")!;
		const cfg = component.parseConfig({}, {} as never);
		const stop = component.start(host, cfg);
		try {
			expect(component.render(cfg, theme)).toMatch(/^󰍛 \d+(\.\d+)?[MG]$/);
		} finally {
			stop();
		}
	});

	test("parseConfig applies defaults and validates refreshMs", () => {
		const component = getComponent("sessionMemory")!;
		expect(component.parseConfig({}, {} as never)).toEqual({ enabled: true, color: "accent", refreshMs: 10_000 });
		expect(() => component.parseConfig({ refreshMs: 500 }, {} as never)).toThrow("refreshMs");
	});
});
