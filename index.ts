/**
 * jev-guard: classify every tool call with TypeSafe's Jev before it runs.
 *
 * Jev is a System One model: no text, only typed answers with confidence, in ~300 ms.
 * One request asks how hard the call is to undo, what kind of action it is, whether it
 * touches secrets or files outside the project, and whether it serves the user's task.
 * Code turns those answers into allow / ask / deny. See classify.mjs for the questions
 * and thresholds.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classify, decide, describe, logDecision } from "./classify.mjs";

type Mode = "enforce" | "log" | "off";
type Config = {
  mode: Mode;
  skipTools: string[]; // tools that never need a judgement; saves a round trip
  timeoutMs: number;
  failOpen: boolean; // API error or timeout: true = let the call run, false = block it
  askWithoutUi: "block" | "allow"; // what an "ask" becomes in print / RPC mode with no one to ask
  showStatus: boolean;
};

const DEFAULTS: Config = { mode: "enforce", skipTools: ["read", "grep", "find", "ls"], timeoutMs: 2500, failOpen: true, askWithoutUi: "block", showStatus: true };
const CONFIG_FILE = join(homedir(), ".pi", "agent", "jev-guard.json");

function loadConfig(): Config {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}

/** Text of the most recent user message on the current branch, so Jev can judge scope. */
function currentTask(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message" || e.message.role !== "user") continue;
    const c = e.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim() || null;
    return null;
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let config = loadConfig();
  const stats = { calls: 0, allow: 0, ask: 0, deny: 0, errors: 0, ms: 0, tokens: 0 };
  let warnedNoKey = false;

  const setStatus = (ctx: ExtensionContext, text?: string) => {
    if (ctx.hasUI && config.showStatus) ctx.ui.setStatus("jev-guard", text);
  };

  pi.on("session_start", (_e, ctx) => {
    config = loadConfig();
    setStatus(ctx, config.mode === "off" ? undefined : `jev-guard ${config.mode}`);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (config.mode === "off" || config.skipTools.includes(event.toolName)) return;
    if (!process.env.TYPESAFE_API_KEY) {
      if (!warnedNoKey && ctx.hasUI) { ctx.ui.notify("jev-guard: TYPESAFE_API_KEY is not set, guard is inactive", "warning"); warnedNoKey = true; }
      return;
    }

    const task = currentTask(ctx);
    let c;
    try {
      c = await classify({ tool: event.toolName, input: event.input, cwd: ctx.cwd, task, timeoutMs: config.timeoutMs, signal: ctx.signal });
    } catch (err) {
      stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      logDecision({ harness: "pi", tool: event.toolName, error: msg });
      setStatus(ctx, `jev-guard error: ${msg.slice(0, 60)}`);
      return config.failOpen ? undefined : { block: true, reason: `jev-guard could not classify this call (${msg}) and failOpen is false` };
    }

    const d = decide(c);
    stats.calls++; stats.ms += c.ms; stats.tokens += c.inputTokens; stats[d.decision]++;
    const label = describe(c, d);
    logDecision({ harness: "pi", mode: config.mode, input: event.input, ...c, ...d });
    setStatus(ctx, label);
    if (config.mode === "log") return;

    if (d.decision === "allow") return;
    if (d.decision === "deny") return { block: true, reason: `jev-guard blocked this call: ${d.reason}. Pick a safer way or ask the user.` };

    // ask
    if (!ctx.hasUI) {
      return config.askWithoutUi === "allow" ? undefined : { block: true, reason: `jev-guard needs a human for this call (${d.reason}) and no one is here. Ask the user first.` };
    }
    const what = event.toolName === "bash" ? String((event.input as { command?: string }).command ?? "") : JSON.stringify(event.input).slice(0, 400);
    const ok = await ctx.ui.confirm(`jev-guard: ${d.reason}`, `${event.toolName}: ${what}\n\nRun it?`);
    if (!ok) return { block: true, reason: `The user declined this call (${d.reason}).` };
  });

  pi.registerCommand("jev-guard", {
    description: "jev-guard: off | log | enforce | stats",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "off" || arg === "log" || arg === "enforce") {
        config.mode = arg;
        setStatus(ctx, arg === "off" ? undefined : `jev-guard ${arg}`);
        ctx.ui.notify(`jev-guard mode: ${arg}`, "info");
        return;
      }
      const avg = stats.calls ? Math.round(stats.ms / stats.calls) : 0;
      ctx.ui.notify(
        `jev-guard ${config.mode} · ${stats.calls} calls · allow ${stats.allow} ask ${stats.ask} deny ${stats.deny} errors ${stats.errors} · avg ${avg}ms · ${stats.tokens.toLocaleString()} tokens ($${((stats.tokens / 1e6) * 0.042).toFixed(4)}) · log ~/.jev-guard/log.jsonl`,
        "info",
      );
    },
  });
}
