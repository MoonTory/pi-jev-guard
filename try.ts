// Classify one tool call from the command line: node try.ts bash "rm -rf node_modules" ["task text"]
import { classify, decide, describe } from './classify.ts'

const [tool = 'bash', raw = 'ls', task] = process.argv.slice(2)

const input: unknown = tool === 'bash' ? { command: raw } : JSON.parse(raw)

const classification = await classify({ tool, input, cwd: process.cwd(), task })

const verdict = decide(classification)

console.log(describe(classification, verdict))

console.log(classification)
