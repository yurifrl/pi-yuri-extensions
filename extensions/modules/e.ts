/**
 * e — Open a file in Neovim, like vim's /e command
 *
 * Usage:
 *   /e filepath     - Open file at filepath
 *   /e .            - Open current directory
 *   /e              - Open current directory
 *   /e @filepath    - Open file at @filepath (same as filepath)
 *
 * Supports absolute paths, relative paths, and @-prefixed paths.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

export default function e(pi: ExtensionAPI): void {
  pi.registerCommand?.("e", {
    description: "Open a file in Neovim, like vim's /e command. Usage: /e [filepath|.]. Opens current directory if no argument provided.",
    handler: async (args, ctx) => {
      const cwd = typeof ctx.cwd === "function" ? ctx.cwd() : ctx.cwd;
      
      // Handle arguments - remove @ prefix if present
      let filePath = (args ?? "").trim();
      if (filePath.startsWith("@")) {
        filePath = filePath.substring(1);
      }
      
      // If no argument or "." is passed, use current directory
      if (filePath === "" || filePath === ".") {
        filePath = cwd;
      } 
      // Handle relative paths
      else if (!path.isAbsolute(filePath)) {
        filePath = path.resolve(cwd, filePath);
      }
      // Absolute paths are used as-is
      
      // Notify user about what we're opening
      try {
        ctx.ui.notify(`Opening ${filePath} in Neovim...`, "info");
      } catch {}
      
      // Spawn Neovim process
      const nvim = spawn("nvim", [filePath], {
        stdio: "inherit",
        cwd: cwd,
        env: process.env,
      });
      
      // Handle process errors
      nvim.on("error", (error) => {
        const errorMsg = `Failed to open Neovim: ${error.message}`;
        console.error(errorMsg);
        try {
          ctx.ui.notify(errorMsg, "error");
        } catch {}
      });
      
      // Handle exit
      nvim.on("exit", (code) => {
        if (code !== 0) {
          const errorMsg = `Neovim exited with code ${code}`;
          console.log(errorMsg);
          try {
            ctx.ui.notify(errorMsg, "warning");
          } catch {}
        } else {
          try {
            ctx.ui.notify(`Closed Neovim: ${filePath}`, "info");
          } catch {}
        }
      });
    },
  });
}