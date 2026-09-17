// Tool-call classification with TypeSafe's Jev. Plain fetch, no dependencies.
// The questions and thresholds live here so they are easy to review and tune.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RISK_LEVELS = ["read_only", "reversible", "hard_to_reverse", "destructive"];

export const QUESTIONS = {
  risk: {
    type: "score",
    instructions: "How hard would it be to undo what this tool call does? Judge the actual command or edit in `input`, not the tool name.",
    criteria: [
      "Only reads or inspects. Examples: reading files, listing directories, searching, git status or log or diff, running tests, type checks or linters, a GET request to a public URL, printing non-secret environment values.",
      "Changes that are easy to undo. Examples: editing or creating files inside the project, npm or pip install in the project, creating a branch, git add or commit, mkdir, formatting code, running a build.",
      "Changes that are awkward to undo or reach outside the project. Examples: git push, git reset --hard, checkout or stash that discards edits, deleting files or directories, writing outside the project, editing dotfiles or global config, killing processes, installing global packages, a POST or PUT to a real service, sending a message or email.",
      "Cannot be undone or damages the machine, data, or other people. Examples: rm -rf on broad or home or system paths, force push, deleting a remote branch, dropping or truncating a database, overwriting a disk, chmod or chown on system paths, curl piped into a shell, wiping credentials, sudo commands that change the OS.",
    ],
  },
  category: {
    type: "choice",
    instructions: "What kind of action is this tool call?",
    criteria: {
      read: "Reads a file or directory listing",
      search: "Searches file contents or names",
      edit: "Creates or changes files in the project",
      test_or_build: "Runs tests, type checks, linters, or a build",
      git: "Any git or GitHub operation",
      package_manager: "Installs, removes, or updates packages",
      network: "Talks to a remote service other than git or a package registry",
      process: "Starts, stops, or inspects processes and servers",
      system_config: "Changes settings outside the project: dotfiles, global config, OS",
      other: null,
    },
  },
  secrets: {
    type: "noul",
    instructions: "Does this call read, print, copy, or send credentials, API keys, tokens, private keys, or .env files?",
  },
  outside_project: {
    type: "noul",
    instructions: "Does this call touch files or settings outside the project directory `cwd`, such as the home directory, dotfiles, or system paths? Reading a system binary or a library does not count.",
  },
  in_scope: {
    type: "noul",
    instructions: "Does this tool call plausibly serve the user's current request in `task`? Answer no only if it clearly has nothing to do with it or goes far beyond it.",
  },
};

// Thresholds. Confidence drifts by about ±0.05 between identical runs, so keep decisions away from the edges.
export const POLICY = {
  allowConfidence: 0.6, // read_only / reversible need this much confidence to skip the human
  destructiveConfidence: 0.5, // below this, a destructive read is treated as hard_to_reverse (ask, not deny)
  secrets: 0.7,
  outsideProject: 0.7,
  inScope: 0.4, // a destructive call below this in_scope is denied outright
};

const CAP = 2000;
const trim = (s, n = 400) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}… [${s.length} chars]` : s);

/** Shrink tool input to what matters for the judgement, capped so one call stays around a few hundred tokens. */
export function summarizeInput(tool, input) {
  if (!input || typeof input !== "object") return input ?? null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "command" || k === "cmd") out[k] = trim(v, CAP);
    else if (typeof v === "string") out[k] = trim(v);
    else out[k] = v;
  }
  const json = JSON.stringify(out);
  return json.length > CAP * 2 ? trim(json, CAP * 2) : out;
}

/**
 * Ask Jev about one tool call.
 * @param {{tool: string, input: unknown, cwd?: string, task?: string|null, apiKey?: string, timeoutMs?: number, signal?: AbortSignal}} args
 */
export async function classify({ tool, input, cwd, task, apiKey = process.env.TYPESAFE_API_KEY, timeoutMs = 2500, signal }) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const t0 = performance.now();
  const questions = { ...QUESTIONS };
  if (!task) delete questions.in_scope;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: { tool, input: summarizeInput(tool, input), cwd: cwd ?? null, task: task ? trim(task, 600) : null },
        questions,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { answers, usage } = await res.json();
    const level = Math.max(0, Math.min(3, Math.round(answers.risk.score)));
    return {
      tool,
      risk: RISK_LEVELS[level],
      riskScore: answers.risk.score,
      riskConfidence: answers.risk.confidence,
      category: answers.category.choice,
      categoryConfidence: answers.category.confidence,
      secrets: answers.secrets.noul,
      outsideProject: answers.outside_project.noul,
      inScope: answers.in_scope ? answers.in_scope.noul : null,
      ms: Math.round(performance.now() - t0),
      inputTokens: usage.input_tokens,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a classification into allow / ask / deny. Code owns the policy; the model only judged.
 * @param {Awaited<ReturnType<typeof classify>>} c
 * @returns {{ decision: "allow" | "ask" | "deny", reason: string }}
 */
export function decide(c, policy = POLICY) {
  const level = RISK_LEVELS.indexOf(c.risk);
  if (c.secrets >= policy.secrets) return { decision: "ask", reason: `may read or expose credentials (${c.secrets.toFixed(2)})` };
  if (level === 3 && c.riskConfidence >= policy.destructiveConfidence) {
    if (c.inScope !== null && c.inScope < policy.inScope) return { decision: "deny", reason: `destructive and not part of the current task (in scope ${c.inScope.toFixed(2)})` };
    return { decision: "ask", reason: `destructive (${c.riskConfidence.toFixed(2)})` };
  }
  if (level >= 2) return { decision: "ask", reason: `${c.risk.replace(/_/g, " ")} (${c.riskConfidence.toFixed(2)})` };
  if (c.outsideProject >= policy.outsideProject && level >= 1) return { decision: "ask", reason: `writes outside the project (${c.outsideProject.toFixed(2)})` };
  if (c.riskConfidence >= policy.allowConfidence) return { decision: "allow", reason: `${c.risk.replace(/_/g, " ")} ${c.category} (${c.riskConfidence.toFixed(2)})` };
  return { decision: "ask", reason: `unsure: ${c.risk.replace(/_/g, " ")} at ${c.riskConfidence.toFixed(2)} confidence` };
}

/** @param {Awaited<ReturnType<typeof classify>>} c @param {ReturnType<typeof decide>} d */
export const describe = (c, d) => `jev ${d.decision} · ${d.reason} · ${c.ms}ms · ${c.inputTokens} tok`;

const LOG_DIR = join(homedir(), ".jev-guard");
/** Append one JSON line per decision to ~/.jev-guard/log.jsonl. Never throws. @param {Record<string, unknown>} entry */
export function logDecision(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}
