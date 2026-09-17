// Classify one tool call from the command line: node try.mjs bash "rm -rf node_modules" ["task text"]
import { classify, decide, describe } from "./classify.mjs";
const [tool = "bash", raw = "ls", task] = process.argv.slice(2);
const input = tool === "bash" ? { command: raw } : JSON.parse(raw);
const c = await classify({ tool, input, cwd: process.cwd(), task });
const d = decide(c);
console.log(describe(c, d));
console.log(c);
