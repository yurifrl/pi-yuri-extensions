/**
 * Behavioral test: continue module against a stub ExtensionAPI modeled on omp 18.0.11.
 * Reproduces the host event order verified in cli.js:
 *   auto_compaction_start → session_compact → auto_compaction_end
 * and the manual /compact path (session_compact with no bracket).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import continueAfterCompact, { shouldContinueAfterCompact } from "./continue.ts";
import { ctxCompaction } from "../../modules/ctx.ts";

type Handler = (event: Record<string, unknown>, ctx: Ctx) => void | Promise<void>;
type Ctx = { setTimeout(fn: () => void, ms?: number): number };

function makePi() {
	const handlers: Record<string, Handler> = {};
	const sent: string[] = [];
	const fire = async (event: string, payload: Record<string, unknown> = {}, ctxExtra: Partial<Ctx> = {}) => {
		const timers: Array<() => void> = [];
		const ctx: Ctx = {
			setTimeout(fn: () => void) {
				timers.push(fn);
				return timers.length;
			},
			...ctxExtra,
		};
		const h = handlers[event];
		if (h) await h({ type: event, ...payload }, ctx);
		return timers;
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	} as unknown as ExtensionAPI;
	return { pi, sent, fire };
}

describe("shouldContinueAfterCompact", () => {
	test("auto bracket, host compaction", () => {
		expect(shouldContinueAfterCompact(true, false)).toBe(true);
	});
	test("manual /compact outside bracket", () => {
		expect(shouldContinueAfterCompact(false, false)).toBe(false);
	});
	test("hook-supplied summary inside bracket", () => {
		expect(shouldContinueAfterCompact(true, true)).toBe(false);
	});
	test("ctx-cap flag alone continues", () => {
		expect(shouldContinueAfterCompact(false, false, true)).toBe(true);
	});
	test("ctx-cap flag with hook summary does not continue", () => {
		expect(shouldContinueAfterCompact(false, true, true)).toBe(false);
	});
});

describe("ctx-cap compaction flow", () => {
	beforeEach(() => {
		ctxCompaction.fromCap = false;
	});

	test("sends prompt when ctx cap triggered the compaction", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		ctxCompaction.fromCap = true; // ctx module sets this before its detached compact()
		const timers = await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(timers.length).toBe(1);
		timers.forEach((fn) => fn());
		expect(sent.length).toBe(1);
		// flag consumed — a later manual /compact stays silent
		const timers2 = await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(timers2.length).toBe(0);
		expect(sent.length).toBe(1);
	});

	test("does not send when ctx cap did not trigger", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(sent.length).toBe(0);
	});

	test("signals expose boolean state", () => {
		expect(typeof ctxCompaction.inFlight).toBe("boolean");
		expect(typeof ctxCompaction.fromCap).toBe("boolean");
	});
});

describe("continueAfterCompact event flow", () => {
	test("sends prompt for auto compaction (start → compact → end)", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("auto_compaction_start", { reason: "threshold", action: "snapcompact" });
		const timers = await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(sent.length).toBe(0); // not yet — deferred via setTimeout
		expect(timers.length).toBe(1);
		timers.forEach((fn) => fn()); // fire the deferred send
		expect(sent).toEqual(["Context compacted. Continue the current task from the compaction summary. Do not ask for the next step."]);
		await fire("auto_compaction_end", { action: "snapcompact", result: {}, aborted: false, willRetry: false });
	});

	test("does NOT send for manual /compact (no bracket)", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(sent.length).toBe(0);
	});

	test("does NOT send for extension-provided summary", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
		await fire("session_compact", { compactionEntry: {}, fromExtension: true });
		expect(sent.length).toBe(0);
	});

	test("nested brackets do not leak depth (start/end/start/end)", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("auto_compaction_start", {});
		await fire("auto_compaction_end", {});
		await fire("auto_compaction_start", {});
		await fire("auto_compaction_end", {});
		// manual compact afterwards must not continue
		await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		expect(sent.length).toBe(0);
	});

	test("leaked bracket (start without end) wrongly continues later manual compact", async () => {
		const { pi, sent, fire } = makePi();
		continueAfterCompact(pi);
		await fire("session_start");
		await fire("auto_compaction_start", {});
		// host aborted before emitting auto_compaction_end (e.g. handoff switched sessions)
		const timers = await fire("session_compact", { compactionEntry: {}, fromExtension: false });
		timers.forEach((fn) => fn()); // fire the deferred send
		// DOCUMENTED RISK: fires because depth is stuck at 1
		expect(sent.length).toBe(1);
	});
});
