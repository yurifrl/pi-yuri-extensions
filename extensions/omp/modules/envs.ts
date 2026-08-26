import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type EnvsProfile = "work" | "personal" | "all";

let activeProfile: EnvsProfile = "all";
let appliedVariables = 0;

function applyEnvironment(profile: EnvsProfile): number {
  let count = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GENERAL_") && value !== undefined) {
      process.env[key.slice("GENERAL_".length)] = value;
      count++;
    }
  }
  const prefix = profile === "all" ? "ALL_" : profile === "work" ? "WORK_" : "PERSONAL_";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && value !== undefined) {
      process.env[key.slice(prefix.length)] = value;
      count++;
    }
  }
  return count;
}

export default function envs(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    appliedVariables = applyEnvironment(activeProfile);
  });
  pi.registerCommand("envs", {
    description: "Switch prefixed environment profile: /envs work|personal|all|status",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "status") {
        ctx.ui.notify(`envs: profile=${activeProfile}, ${appliedVariables} variables applied`);
        return;
      }
      if (requested !== "work" && requested !== "personal" && requested !== "all") {
        ctx.ui.notify("Usage: /envs work | personal | all | status", "error");
        return;
      }
      activeProfile = requested;
      appliedVariables = applyEnvironment(activeProfile);
      ctx.ui.notify(`envs: switched to ${activeProfile} (${appliedVariables} variables applied)`);
    },
  });
}
