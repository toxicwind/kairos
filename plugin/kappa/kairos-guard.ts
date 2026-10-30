// kairos-guard — kappa/kilo-code/opencode adapter for the kairos 2s guard.
//
// In-band enforcement: intercepts every bash tool call BEFORE execution.
//   deny    → throws (host blocks the call; the model sees the reason + fix)
//   replace → rewrites args.command through run-fast (deadline + full persist)
//   allow   → untouched
//
// Wire it (global ~/.config/kappa/kappa.jsonc or project kappa.json):
//   "plugin": ["file:///home/toxic/pens/olympus/products/kairos/plugin/kappa/kairos-guard.ts"]
//
// Backwards compatible: kappa-code, kilo-code and opencode all implement the
// same Plugin Hooks contract ("tool.execute.before" with mutable output.args).
import { verdict } from "../../src/guard.ts";

export const KairosGuardPlugin = async () => {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      if (input.tool !== "bash") return;
      const command: string | undefined = output.args?.command;
      if (!command) return;
      const v = verdict(command);
      if (v.action === "deny") {
        throw new Error(`[kairos] ${v.reason} — MUST DO: ${v.fix}`);
      }
      if (v.action === "replace" && v.replacement) {
        output.args = { ...output.args, command: v.replacement };
      }
    },
  };
};

export default KairosGuardPlugin;
