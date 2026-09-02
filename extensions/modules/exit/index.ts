import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Exit — registers the `exit` tool.
 *
 * The model can call it to end the session: graceful shutdown, deferred by the
 * harness to the next idle boundary so queued steering/follow-up messages
 * drain first (same path as the /exit slash command). Registered as
 * `loadMode: "essential"` so it stays top-level in the tool schema and the
 * model can always reach it directly, even under xd:// device mounting.
 *
 * This is how subagents (or the model itself) terminate the session when their
 * work is done. The optional `reason` is echoed into the transcript; the tool
 * is auto-approved (read tier). Disable: "modules": { "exit": false }.
 */
export default function exit(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "exit",
		label: "Exit",
		description:
			"End this omp session: graceful shutdown after the current turn. " +
			"Call when the work is complete and the user no longer needs this session.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the session is ending, e.g. 'work complete'." },
			},
			additionalProperties: false,
		},
		// omp-only fields (approval tier, tool-schema load mode). Registered through a
		// widened type so the same definition typechecks against pi, which lacks them.
		...(pi ? { approval: "read" as const, loadMode: "essential" as const } : {}),
		execute: async (_toolCallId, params: { reason?: string }, _signal, _onUpdate, ctx) => {
			ctx.shutdown();
			return {
				content: [
					{
						type: "text",
						text: params.reason ? `Session ending: ${params.reason}` : "Session ending.",
					},
				],
				details: undefined,
			};
		},
	});
}
