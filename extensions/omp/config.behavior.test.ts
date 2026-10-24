/**
 * Behavior: the omp config reader must not drop unknown top-level fields.
 * readOmpConfig's old whitelist dropped every config field added after the whitelist was
 * written — ctxLimitRatio (learned ctx calibration) and continueAfterCompactPrompt persisted
 * on write but read back as undefined, silently disabling those features.
 * parseOmpConfig passes unknown fields through; only known shapes are normalized.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type YuriExtensionsConfig } from "../modules/config.ts";
import { parseOmpConfig } from "./config.ts";

describe("parseOmpConfig", () => {
	test("passes through fields the reader does not know about", () => {
		const config = parseOmpConfig(
			JSON.stringify({
				modules: {},
				ctxLimitRatio: 1.03,
				continueAfterCompactPrompt: "continue",
			}),
		);
		expect(config.ctxLimitRatio).toBe(1.03);
		expect(config.continueAfterCompactPrompt).toBe("continue");
	});

	test("keeps known fields and normalizes statusline", () => {
		const config = parseOmpConfig(
			JSON.stringify({
				modules: { snapshot: { enabled: false } },
				budgetGates: [5, 10],
				ctxLimit: 250_000,
				ctxLimitAction: "compact",
				statusline: { order: ["model"], components: { model: { color: "warning" } } },
			}),
		);
		expect(config.ctxLimit).toBe(250_000);
		expect(config.ctxLimitAction).toBe("compact");
		expect(config.budgetGates).toEqual([5, 10]);
		expect(config.modules?.snapshot?.enabled).toBe(false);
		expect(config.statusline?.order).toEqual(["model"]);
	});

	test("fills module toggles from DEFAULT_CONFIG and rejects malformed JSON", () => {
		expect(parseOmpConfig(JSON.stringify({ modules: {} }))).toEqual(DEFAULT_CONFIG);
		expect(parseOmpConfig(JSON.stringify({ modules: null }))).toEqual(DEFAULT_CONFIG);
		expect(() => parseOmpConfig("not json")).toThrow(); // readOmpConfig catches and falls back
	});
});
