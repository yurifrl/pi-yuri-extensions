/**
 * Behavioral test: /ctx command against a stub ExtensionAPI.
 * The statusline consumes ctxLimitSignal, so the command must update it in place (not only the config file).
 * With action "compact" the cap is applied to the live session model as windowForCap(cap) — the smallest
 * window whose native compaction threshold reaches the cap; "stop" must leave the session window untouched.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setConfigStore, type YuriExtensionsConfig } from "./config.ts";
import contextLimit, { ctxLimitSignal, nextRealRatio, realEstimate, windowForCap } from "./ctx.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
type CommandHandler = (args: string, ctx: unknown) => void | Promise<void>;

const CATALOG_WINDOW = 1_310_720;

interface CtxHarness {
	pi: ExtensionAPI;
	commands: Record<string, CommandHandler>;
	notes: string[];
	setModelCalls: Array<{ contextWindow: number }>;
	catalogModel: { contextWindow: number };
	readonly model: { contextWindow: number };
	resetModel(): void;
	fire(event: string, payload?: unknown): Promise<void>;
	ctx: unknown;
	setGauge(tokens: number | undefined): void;
}

function makePi(): CtxHarness {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, CommandHandler> = {};
	const notes: string[] = [];
	const setModelCalls: Array<{ contextWindow: number }> = [];
	const catalogModel = { provider: "t", id: "t/m", contextWindow: CATALOG_WINDOW };
	let sessionModel: { contextWindow: number } = catalogModel;
	let gauge: number | undefined;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: (name: string, def: { handler: CommandHandler }) => {
			commands[name] = def.handler;
		},
		setModel: async (patched: { contextWindow: number }) => {
			setModelCalls.push(patched);
			sessionModel = patched; // omp swaps the live session model to the patched clone
			return true;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: { notify: (message: string) => notes.push(message) },
		getContextUsage: () => (gauge === undefined ? undefined : { tokens: gauge }),
		get model() {
			return sessionModel;
		},
		modelRegistry: { getAvailable: () => [catalogModel] },
	};
	const fire = async (event: string, payload?: unknown) => handlers[event]?.(payload, ctx);
	return {
		pi,
		commands,
		notes,
		setModelCalls,
		catalogModel,
		fire,
		ctx,
		setGauge: (tokens: number | undefined) => {
			gauge = tokens;
		},
		get model() {
			return sessionModel;
		},
		resetModel() {
			sessionModel = catalogModel; // a fresh session starts with the catalog model
		},
	};
}

describe("/ctx command", () => {
	let harness: CtxHarness;

	/** In-memory shared-config store: mirrors the JSON file's read/write round-trip. */
	function memoryStore(initial: Partial<YuriExtensionsConfig> = {}): Partial<YuriExtensionsConfig> {
		const state: Partial<YuriExtensionsConfig> = { modules: {}, ...initial };
		setConfigStore({
			read: () => state,
			write: (config) => Object.assign(state, config),
		});
		return state;
	}

	beforeEach(() => {
		setConfigStore({ read: () => ({ modules: {} }), write: () => {} });
		harness = makePi();
		contextLimit(harness.pi);
		void harness.fire("session_start"); // empty config store → cap unset
	});

	test("set updates the shared signal the statusline reads", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		expect(ctxLimitSignal.limit).toBe(300_000);

		await harness.commands.ctx!("off", harness.ctx);
		expect(ctxLimitSignal.limit).toBeUndefined();
	});

	test("session set is not persisted — a new session reverts to the global cap", async () => {
		memoryStore({ ctxLimit: 250_000, ctxLimitAction: "compact" });
		await harness.fire("session_start"); // loads the persisted global cap
		expect(ctxLimitSignal.limit).toBe(250_000);

		await harness.commands.ctx!("set 500k", harness.ctx);
		expect(ctxLimitSignal.limit).toBe(500_000);
		expect(harness.notes.at(-1)).toContain("(this session)");

		await harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBe(250_000); // config still holds the global cap
	});

	test("global set persists and survives session_start", async () => {
		const state = memoryStore();
		await harness.commands.ctx!("global set 500k", harness.ctx);
		expect(ctxLimitSignal.limit).toBe(500_000);
		expect(state.ctxLimit).toBe(500_000);
		expect(harness.notes.at(-1)).toContain("(global, saved)");

		await harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBe(500_000); // every new session loads the saved cap
	});

	test("global off clears the persisted cap", async () => {
		const state = memoryStore({ ctxLimit: 250_000 });
		await harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBe(250_000);

		await harness.commands.ctx!("global off", harness.ctx);
		expect(ctxLimitSignal.limit).toBeUndefined();
		expect(state.ctxLimit).toBeUndefined();

		await harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBeUndefined();
	});

	test("global action persists the cap action", async () => {
		const state = memoryStore();
		await harness.commands.ctx!("global action stop", harness.ctx);
		expect(state.ctxLimitAction).toBe("stop");
	});

	test("status reports the session cap and the global cap", async () => {
		memoryStore({ ctxLimit: 250_000, ctxLimitAction: "compact" });
		await harness.fire("session_start");
		await harness.commands.ctx!("set 100k", harness.ctx);
		await harness.commands.ctx!("status", harness.ctx);
		expect(harness.notes.at(-1)).toContain("100k"); // session cap
		expect(harness.notes.at(-1)).toContain("250k"); // global cap
	});

	test("set patches the live session model so native compaction fires at the cap", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		const window = harness.model.contextWindow;
		expect(window).toBe(windowForCap(300_000)); // minimal window whose native threshold reaches the cap
		expect(window - Math.max(Math.floor(window * 0.15), 16_384)).toBeGreaterThanOrEqual(300_000);
		expect(harness.catalogModel.contextWindow).toBe(CATALOG_WINDOW); // registry entry untouched
	});

	test("off restores the catalog window", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		await harness.commands.ctx!("off", harness.ctx);
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(CATALOG_WINDOW);
		expect(harness.model.contextWindow).toBe(CATALOG_WINDOW);
	});

	test("stop action keeps the real session window", async () => {
		await harness.commands.ctx!("action stop", harness.ctx);
		await harness.commands.ctx!("set 300k", harness.ctx);
		expect(ctxLimitSignal.limit).toBe(300_000);
		expect(harness.setModelCalls).toHaveLength(0);
	});

	test("switching back to compact re-patches the window", async () => {
		await harness.commands.ctx!("action stop", harness.ctx);
		await harness.commands.ctx!("set 300k", harness.ctx);
		await harness.commands.ctx!("action compact", harness.ctx);
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(windowForCap(300_000));
	});

	test("session_start re-applies the persisted cap to the session model", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		harness.resetModel(); // a fresh session starts with the catalog model
		setConfigStore({ read: () => ({ modules: {}, ctxLimit: 300_000, ctxLimitAction: "compact" }), write: () => {} });
		await harness.fire("session_start");
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(windowForCap(300_000));
		expect(harness.model.contextWindow).toBe(windowForCap(300_000));
	});

	test("turn_end learns the gauge→real ratio from provider usage and persists it", async () => {
		const state = memoryStore();
		harness.setGauge(150_000); // omp's local estimate for this turn
		await harness.fire("turn_end", { message: { usage: { totalTokens: 50_000 } } }); // provider-true size
		expect(ctxLimitSignal.realRatio).toBe(3);
		expect(state.ctxLimitRatio).toBe(3);
	});

	test("later turns EMA the calibration instead of jumping", async () => {
		memoryStore();
		harness.setGauge(150_000);
		await harness.fire("turn_end", { message: { usage: { totalTokens: 50_000 } } });
		harness.setGauge(99_000);
		await harness.fire("turn_end", { message: { usage: { totalTokens: 45_000 } } });
		expect(ctxLimitSignal.realRatio).toBe(2.8); // 3 + (2.2 − 3) × 0.25
	});

	test("session_start loads the persisted calibration", async () => {
		memoryStore({ ctxLimitRatio: 2.5 });
		await harness.fire("session_start");
		expect(ctxLimitSignal.realRatio).toBe(2.5);
	});

	test("unusable samples never poison a good calibration", async () => {
		memoryStore({ ctxLimitRatio: 2.5 });
		await harness.fire("session_start");
		harness.setGauge(150_000);
		await harness.fire("turn_end", { message: { usage: { totalTokens: 1_000 } } }); // provider total below floor
		expect(ctxLimitSignal.realRatio).toBe(2.5);
		harness.setGauge(400_000);
		await harness.fire("turn_end", { message: { usage: { totalTokens: 20_000 } } }); // ratio 20 outside [1, 10]
		expect(ctxLimitSignal.realRatio).toBe(2.5);
	});
});

describe("windowForCap", () => {
	/** omp's native compaction threshold: window − max(15%·window floor, 16,384 fixed reserve). */
	const thresholdOf = (window: number) => window - Math.max(Math.floor(window * 0.15), 16_384);

	test("proportional regime: threshold lands exactly on the cap", () => {
		for (const cap of [100_000, 250_000, 300_000, 500_000, 1_000_000]) {
			expect(thresholdOf(windowForCap(cap))).toBe(cap);
		}
	});

	test("fixed-reserve regime: small caps resolve to cap + 16384", () => {
		for (const cap of [10_000, 50_000, 92_842]) {
			expect(windowForCap(cap)).toBe(cap + 16_384);
			expect(thresholdOf(windowForCap(cap))).toBe(cap);
		}
	});

	test("window is minimal — one token smaller no longer reaches the cap", () => {
		for (const cap of [10_000, 50_000, 92_842, 92_843, 300_000, 1_000_000]) {
			expect(thresholdOf(windowForCap(cap) - 1)).toBeLessThan(cap);
		}
	});
});

describe("nextRealRatio", () => {
	test("first good sample wins outright, later samples EMA in", () => {
		expect(nextRealRatio(undefined, 150_000, 50_000)).toBe(3);
		expect(nextRealRatio(3, 99_000, 45_000)).toBe(2.8); // 3 + (2.2 − 3) × 0.25
	});

	test("unusable samples return the previous calibration untouched", () => {
		expect(nextRealRatio(2.5, undefined, 50_000)).toBe(2.5); // no gauge
		expect(nextRealRatio(2.5, 150_000, undefined)).toBe(2.5); // no provider usage
		expect(nextRealRatio(2.5, 150_000, 1_000)).toBe(2.5); // tiny turn — noise
		expect(nextRealRatio(2.5, 400_000, 20_000)).toBe(2.5); // ratio outside [1, 10]
	});
});

describe("realEstimate", () => {
	test("divides the gauge by the calibration", () => {
		expect(realEstimate(300_000, 2.5)).toBe(120_000);
		expect(realEstimate(150_000, 3)).toBe(50_000);
	});

	test("uncalibrated or degenerate ratios yield undefined", () => {
		expect(realEstimate(300_000, undefined)).toBeUndefined();
		expect(realEstimate(undefined, 2.5)).toBeUndefined();
		expect(realEstimate(300_000, 1)).toBeUndefined(); // ×1 means "no over-read" — nothing to translate
	});
});
