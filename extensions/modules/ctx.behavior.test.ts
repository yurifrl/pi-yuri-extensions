/**
 * Behavioral test: /ctx command against a stub ExtensionAPI.
 * The statusline consumes ctxLimitSignal, so the command must update it in place (not only the config file).
 * With action "compact" the cap is also applied to the live session model (setModel clone) so the context
 * bar and compaction budget follow; "stop" must leave the session window untouched.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setConfigStore, type YuriExtensionsConfig } from "./config.ts";
import contextLimit, { ctxLimitSignal } from "./ctx.ts";

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
	fire(event: string): Promise<void>;
	ctx: unknown;
}

function makePi(): CtxHarness {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, CommandHandler> = {};
	const notes: string[] = [];
	const setModelCalls: Array<{ contextWindow: number }> = [];
	const catalogModel = { provider: "t", id: "t/m", contextWindow: CATALOG_WINDOW };
	let sessionModel: { contextWindow: number } = catalogModel;
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
		get model() {
			return sessionModel;
		},
		modelRegistry: { getAvailable: () => [catalogModel] },
	};
	const fire = async (event: string) => handlers[event]?.(undefined, ctx);
	return {
		pi,
		commands,
		notes,
		setModelCalls,
		catalogModel,
		fire,
		ctx,
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

	test("set patches the live session model to the cap", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(300_000);
		expect(harness.model.contextWindow).toBe(300_000); // the bar reads the live session model
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
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(300_000);
	});

	test("session_start re-applies the persisted cap to the session model", async () => {
		await harness.commands.ctx!("set 300k", harness.ctx);
		harness.resetModel(); // a fresh session starts with the catalog model
		setConfigStore({ read: () => ({ modules: {}, ctxLimit: 300_000, ctxLimitAction: "compact" }), write: () => {} });
		await harness.fire("session_start");
		expect(harness.setModelCalls.at(-1)?.contextWindow).toBe(300_000);
		expect(harness.model.contextWindow).toBe(300_000);
	});
});
