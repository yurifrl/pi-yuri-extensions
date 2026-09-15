/**
 * Behavioral test: /ctx command against a stub ExtensionAPI.
 * The statusline consumes ctxLimitSignal, so the command must update it in place (not only the config file).
 * With action "compact" the cap is also applied to the live session model (setModel clone) so the context
 * bar and compaction budget follow; "stop" must leave the session window untouched.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setConfigStore } from "./config.ts";
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

	test("session_start re-reads the persisted cap", async () => {
		await harness.commands.ctx!("set 500k", harness.ctx);
		expect(ctxLimitSignal.limit).toBe(500_000);

		await harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBeUndefined();
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
