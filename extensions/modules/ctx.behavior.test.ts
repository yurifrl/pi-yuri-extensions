/**
 * Behavioral test: /ctx command against a stub ExtensionAPI.
 * The statusline consumes ctxLimitSignal, so the command must update it in place (not only the config file).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import contextLimit, { ctxLimitSignal } from "./ctx.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
type CommandHandler = (args: string, ctx: unknown) => void | Promise<void>;

interface CtxHarness {
	pi: ExtensionAPI;
	commands: Record<string, CommandHandler>;
	notes: string[];
	fire(event: string): void;
	ctx: { ui: { notify(message: string): void } };
}

function makePi(): CtxHarness {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, CommandHandler> = {};
	const notes: string[] = [];
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: (name: string, def: { handler: CommandHandler }) => {
			commands[name] = def.handler;
		},
	} as unknown as ExtensionAPI;
	const ctx = { ui: { notify: (message: string) => notes.push(message) } };
	const fire = (event: string) => handlers[event]?.(undefined, ctx);
	return { pi, commands, notes, fire, ctx };
}

describe("/ctx command", () => {
	let harness: CtxHarness;

	beforeEach(() => {
		harness = makePi();
		contextLimit(harness.pi);
		harness.fire("session_start"); // no config store registered → cap unset
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

		harness.fire("session_start");
		expect(ctxLimitSignal.limit).toBeUndefined();
	});
});
