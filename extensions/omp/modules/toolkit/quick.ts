/**
 * Quick — send a task to a stronger model without giving up the session's own.
 *
 * One-shot form switches the session to the target model, sends the message, and restores the previous model and
 * thinking level on the first real settle (armed only after the switch succeeds, skipped while auto-continuation is
 * scheduled). No-arg form toggles the target for the session; repeating it on the active target restores the baseline.
 * A failed restore keeps the baseline so the next attempt retries instead of adopting the quick model. Targets resolve
 * by pinned spec with a catalog scan fallback.
 *
 * /quick-oppus | /qo — aihub/claude-opus-5 · /quick-gpt | /qg — aihub/gpt-5.6-terra · /quick-oppus-plan | /qop and
 * /quick-gpt-plan | /qgp — one-shot "Plan: <script>". Disable: "modules": { "quick": false }.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

type Target = "oppus" | "gpt";

type Baseline = { model: Model; thinking: ThinkingLevel | undefined };

type State = {
	/** Model + thinking level to restore when the quick switch ends. */
	baseline?: Baseline;
	/** Target currently owning the session model (toggle or single-shot). */
	activeTarget?: Target;
	/** Single-shot in flight: restore on the first real agent_end. */
	oneShot?: { armed: boolean };
};

const TARGETS: Record<Target, { spec: string; patterns: RegExp[] }> = {
	oppus: { spec: "aihub/claude-opus-5", patterns: [/opus/i] },
	gpt: { spec: "aihub/gpt-5.6-terra", patterns: [/gpt-5\.6-terra(?!-pro)/i] },
};

function resolveTarget(ctx: ExtensionCommandContext, target: Target): Model | undefined {
	const { spec, patterns } = TARGETS[target];
	const models = ctx.models;
	const resolved = models.resolve(spec);
	if (resolved) return resolved;
	// Fallback for machines whose catalog drifted from the pinned spec.
	return models.list().find((m) => patterns.some((p) => p.test(`${m.provider}/${m.id} ${m.name}`)));
}

function restore(pi: ExtensionAPI, state: State): Promise<boolean> {
	const baseline = state.baseline;
	if (!baseline) {
		state.activeTarget = undefined;
		state.oneShot = undefined;
		return Promise.resolve(true);
	}
	return pi.setModel(baseline.model).then((ok) => {
		if (!ok) {
			// Failed restore keeps the baseline: the next toggle-off (or same-target
			// one-shot) retries instead of silently adopting the quick model as the
			// new baseline.
			return false;
		}
		if (baseline.thinking) pi.setThinkingLevel(baseline.thinking);
		state.baseline = undefined;
		state.activeTarget = undefined;
		state.oneShot = undefined;
		return true;
	});
}

async function switchTo(pi: ExtensionAPI, ctx: ExtensionCommandContext, target: Target): Promise<Model | undefined> {
	const model = resolveTarget(ctx, target);
	if (!model) {
		ctx.ui.notify(`Quick: ${TARGETS[target].spec} not found in the model catalog.`, "error");
		return undefined;
	}
	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`Quick: no API key for ${model.provider}/${model.id}.`, "error");
		return undefined;
	}
	return model;
}

async function run(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: State, target: Target, message: string): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Quick: waiting for the current run to finish…", "info");
		await ctx.waitForIdle();
	}
	const toggledToSame = state.activeTarget === target && !state.oneShot;
	if (!ctx.model) {
		ctx.ui.notify("Quick: no model selected in this session.", "error");
		return;
	}
	if (!state.activeTarget) {
		state.baseline = { model: ctx.model, thinking: pi.getThinkingLevel() };
	}
	state.activeTarget = target;
	if (!(await switchTo(pi, ctx, target))) {
		if (!state.baseline || ctx.models.current()?.id === state.baseline.model.id) {
			// Switch failed before we left the baseline model: drop the whole activation.
			state.baseline = undefined;
			state.activeTarget = undefined;
		}
		return;
	}
	state.oneShot = { armed: true };
	pi.sendUserMessage(message);
	ctx.ui.notify(`Quick ${target}: ${TARGETS[target].spec}${toggledToSame ? " (already active)" : ""}`, "info");
}

function commandHandler(
	pi: ExtensionAPI,
	state: State,
	target: Target,
	plan: boolean,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	return async (args, ctx) => {
		const script = args.trim();
		if (script) {
			await run(pi, ctx, state, target, plan ? `Plan: ${script}` : script);
			return;
		}
		if (plan) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Usage: /quick-${target}-plan <script>`, "error");
				return;
			}
			const input = await ctx.ui.input("Script to plan", "Enter to cancel");
			// (input intentionally falls through to the trim guard below)
			if (!input || !input.trim()) return;
			await run(pi, ctx, state, target, `Plan: ${input.trim()}`);
			return;
		}
		// No args: toggle the target for the session; off only when the same
		// target is active. Off from the wrong target just flips targets.
		if (!ctx.isIdle()) {
			ctx.ui.notify("Quick: waiting for the current run to finish…", "info");
			await ctx.waitForIdle();
		}
		if (state.activeTarget === target && !state.oneShot) {
			const restored = await restore(pi, state);
			ctx.ui.notify(
				restored
					? "Quick: off — previous model restored"
					: "Quick: restore failed — still on the quick model; baseline kept, try again",
				restored ? "info" : "error",
			);
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("Quick: no model selected in this session.", "error");
			return;
		}
		if (!state.activeTarget) {
			state.baseline = { model: ctx.model, thinking: pi.getThinkingLevel() };
		}
		state.oneShot = undefined;
		state.activeTarget = target;
		if (await switchTo(pi, ctx, target)) {
			ctx.ui.notify(`Quick ${target}: on — ${TARGETS[target].spec} for this session`, "info");
		} else if (state.baseline && ctx.models.current()?.id === state.baseline.model.id) {
			state.baseline = undefined;
			state.activeTarget = undefined;
		}
	};
}

export default function quick(pi: ExtensionAPI): void {
	const state: State = {};

	pi.on("agent_end", (event) => {
		// willContinue: auto-retry/continuation is scheduled; the run is not done.
		// Keep the one-shot armed and restore on the first real settle.
		if (event.willContinue) return;
		if (state.oneShot?.armed && state.activeTarget) {
			state.oneShot = undefined;
			void restore(pi, state);
		}
	});

	const register = (name: string, target: Target, plan: boolean, description: string) => {
		pi.registerCommand(name, { description, handler: commandHandler(pi, state, target, plan) });
	};

	register("quick-oppus", "oppus", false, "Toggle aihub opus 5 for this session; with args, one-shot: /quick-oppus [message]");
	register("quick-oppus-plan", "oppus", true, "One-shot 'Plan: <script>' on aihub opus 5, then restore the previous model");
	register("quick-gpt", "gpt", false, "Toggle aihub gpt-5.6-terra for this session; with args, one-shot: /quick-gpt [message]");
	register("quick-gpt-plan", "gpt", true, "One-shot 'Plan: <script>' on aihub gpt-5.6-terra, then restore the previous model");
	register("qo", "oppus", false, "Alias for /quick-oppus");
	register("qop", "oppus", true, "Alias for /quick-oppus-plan");
	register("qg", "gpt", false, "Alias for /quick-gpt");
	register("qgp", "gpt", true, "Alias for /quick-gpt-plan");
}
