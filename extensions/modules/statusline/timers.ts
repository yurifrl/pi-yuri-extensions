/**
 * Session-scoped interval helper.
 *
 * Prefers omp's managed ctx.setInterval (throw-contained, auto-cleared on session_shutdown) and falls back to
 * the global timer for pi, whose ExtensionContext has no timer helpers. Callers must invoke the returned
 * teardown on session stop/switch — a global fallback timer would otherwise outlive the session.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type ManagedContext = ExtensionContext & {
	setInterval?: (callback: () => void, ms?: number) => unknown;
	clearTimer?: (timer: never) => void;
};

export function setIntervalScoped(ctx: ExtensionContext | undefined, callback: () => void, ms: number): () => void {
	const managed = ctx as ManagedContext | undefined;
	if (typeof managed?.setInterval === "function") {
		const timer = managed.setInterval(callback, ms);
		return () => managed.clearTimer?.(timer as never);
	}
	const id = setInterval(callback, ms);
	return () => clearInterval(id);
}
