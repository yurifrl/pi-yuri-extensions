import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("update", {
    description: "Update global pnpm packages and pi, then reload the session",
    handler: async (_args, ctx) => {
      const STATUS_KEY = "update";

      const steps = [
        { label: "pnpm", cmd: "pnpm", args: ["up", "-g", "--latest"] },
        { label: "pi", cmd: "pi", args: ["update"] },
      ];

      ctx.ui.notify("Starting update in background…", "info");

      // Run in background so the user can keep working
      (async () => {
        const errors: string[] = [];

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          ctx.ui.setStatus(STATUS_KEY, `⏳ Updating ${step.label}… (${i + 1}/${steps.length})`);

          try {
            const result = await pi.exec(step.cmd, step.args, { timeout: 120_000 });

            if (result.code !== 0) {
              const msg = (result.stderr || result.stdout || "").trim();
              errors.push(`${step.cmd} ${step.args.join(" ")} failed (exit ${result.code}): ${msg}`);
              break;
            }
          } catch (err: unknown) {
            errors.push(`${step.cmd}: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }

        ctx.ui.setStatus(STATUS_KEY, undefined);

        if (errors.length > 0) {
          ctx.ui.notify(`Update failed:\n${errors.join("\n")}`, "error");
          return;
        }

        ctx.ui.notify("✅ All updates complete!", "success");
        const reload = await ctx.ui.confirm("Reload session?", "Updates installed. Reload to pick up changes?");

        if (reload) {
          await ctx.reload();
        }
      })();
    },
  });
}
