import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function editor(pi: ExtensionAPI): void {
  pi.registerCommand("e", {
    description: "Open a file or current directory in Neovim: /e [path]",
    handler: async (args, ctx) => {
      const input = args.trim().replace(/^@/, "");
      const target = !input || input === "." ? ctx.cwd : path.resolve(ctx.cwd, input);
      ctx.ui.notify(`Opening ${target} in Neovim…`);
      const child = spawn("nvim", [target], { cwd: ctx.cwd, env: process.env, stdio: "inherit" });
      child.on("error", (error) => ctx.ui.notify(`Failed to open Neovim: ${error.message}`, "error"));
      child.on("exit", (code) => {
        if (code !== 0) ctx.ui.notify(`Neovim exited with code ${code ?? "unknown"}`, "warning");
      });
    },
  });
}
