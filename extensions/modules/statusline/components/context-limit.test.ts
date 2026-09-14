/**
 * context-limit component: the cap must be read live per frame, not snapshotted.
 * Regression: /ctx set used to leave the statusline showing the session-start cap until a new session.
 */
import { describe, expect, test } from "bun:test";
import { getComponent } from "../registry.ts";
import { publishContextSource } from "./context-limit.ts";
import type { StatuslineTheme } from "../types.ts";

const theme: StatuslineTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	getBgAnsi: () => "",
};

function fakeUsage(tokens: number): never {
	return { getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }) } as never;
}

describe("contextLimit component", () => {
	test("render reads the cap live: /ctx changes appear on the next frame", () => {
		const cap = { value: 200_000 };
		publishContextSource(() => fakeUsage(36_000), () => cap.value);
		const component = getComponent("contextLimit")!;
		const cfg = component.parseConfig({}, {} as never);

		expect(component.render(cfg, theme)).toContain("36k/200");

		cap.value = 300_000;
		expect(component.render(cfg, theme)).toContain("36k/300");
	});

	test("hides the segment when no cap is set or usage is unknown", () => {
		publishContextSource(() => fakeUsage(36_000), () => undefined);
		const component = getComponent("contextLimit")!;
		const cfg = component.parseConfig({}, {} as never);
		expect(component.render(cfg, theme)).toBe("");

		publishContextSource(() => undefined, () => 200_000);
		expect(component.render(cfg, theme)).toBe("");
	});
});
