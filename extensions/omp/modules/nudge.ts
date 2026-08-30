import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function nudge(pi: ExtensionAPI): void {
	pi.registerCommand("nudge", {
		description: "Interrupt if working, then send 'continue' (unstick a stalled run)",
		handler: async (_args, ctx) => {
			const idle = ctx.isIdle();
			try {
				if (!idle) ctx.abort();
				pi.sendUserMessage("continue", idle ? undefined : { deliverAs: "followUp" });
				ctx.ui.notify(idle ? "nudge: sent 'continue'" : "nudge: interrupted + queued 'continue'", "info");
			} catch (err) {
				ctx.ui.notify(`nudge failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
