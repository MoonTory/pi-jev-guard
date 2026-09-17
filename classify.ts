// Tool-call classification with TypeSafe's Jev. Plain fetch, no dependencies.
// The questions and thresholds live here so they are easy to review and tune.
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const RISK_LEVELS = ['read_only', 'reversible', 'hard_to_reverse', 'destructive'] as const

export type RiskLevel = (typeof RISK_LEVELS)[number]

export type Decision = 'allow' | 'ask' | 'deny'

export type Classification = {
	tool: string
	risk: RiskLevel
	riskScore: number
	riskConfidence: number
	category: string
	categoryConfidence: number
	secrets: number
	outsideProject: number
	inScope: number | null
	ms: number
	inputTokens: number
}

export type Verdict = { decision: Decision; reason: string }

type Policy = {
	allowConfidence: number
	destructiveConfidence: number
	secrets: number
	outsideProject: number
	inScope: number
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type NoulAnswer = { noul: number }

type ChoiceAnswer = { choice: string; confidence: number }

type ScoreAnswer = { score: number; confidence: number }

type Answers = {
	risk: ScoreAnswer
	category: ChoiceAnswer
	secrets: NoulAnswer
	outside_project: NoulAnswer
	in_scope?: NoulAnswer
}

type ApiResponse = { answers: Answers; usage: { input_tokens: number } }

export const QUESTIONS = {
	risk: {
		type: 'score',
		instructions:
			'How hard would it be to undo what this tool call does? Judge the actual command or edit in `input`, not the tool name.',
		criteria: [
			'Only reads or inspects. Examples: reading files, listing directories, searching, git status or log or diff, running tests, type checks or linters, a GET request to a public URL, printing non-secret environment values.',
			'Changes that are easy to undo. Examples: editing or creating files inside the project, npm or pip install in the project, creating a branch, git add or commit, mkdir, formatting code, running a build.',
			'Changes that are awkward to undo or reach outside the project. Examples: git push, git reset --hard, checkout or stash that discards edits, deleting files or directories, writing outside the project, editing dotfiles or global config, killing processes, installing global packages, a POST or PUT to a real service, sending a message or email.',
			'Cannot be undone or damages the machine, data, or other people. Examples: rm -rf on broad or home or system paths, force push, deleting a remote branch, dropping or truncating a database, overwriting a disk, chmod or chown on system paths, curl piped into a shell, wiping credentials, sudo commands that change the OS.'
		]
	},
	category: {
		type: 'choice',
		instructions: 'What kind of action is this tool call?',
		criteria: {
			read: 'Reads a file or directory listing',
			search: 'Searches file contents or names',
			edit: 'Creates or changes files in the project',
			test_or_build: 'Runs tests, type checks, linters, or a build',
			git: 'Any git or GitHub operation',
			package_manager: 'Installs, removes, or updates packages',
			network: 'Talks to a remote service other than git or a package registry',
			process: 'Starts, stops, or inspects processes and servers',
			system_config: 'Changes settings outside the project: dotfiles, global config, OS',
			other: null
		}
	},
	secrets: {
		type: 'noul',
		instructions:
			'Does this call read, print, copy, or send credentials, API keys, tokens, private keys, or .env files?'
	},
	outside_project: {
		type: 'noul',
		instructions:
			'Does this call touch files or settings outside the project directory `cwd`, such as the home directory, dotfiles, or system paths? Reading a system binary or a library does not count.'
	},
	in_scope: {
		type: 'noul',
		instructions:
			"Does this tool call plausibly serve the user's current request in `task`? Answer no only if it clearly has nothing to do with it or goes far beyond it."
	}
}

// Confidence drifts by about ±0.05 between identical runs, so keep decisions away from the edges.
export const POLICY: Policy = {
	allowConfidence: 0.6, // read_only / reversible need this much confidence to skip the human
	destructiveConfidence: 0.5, // below this, a destructive read is treated as hard_to_reverse (ask, not deny)
	secrets: 0.7,
	outsideProject: 0.7,
	inScope: 0.4 // a destructive call below this in_scope is denied outright
}

const CAP = 2000

const trim = (value: unknown, max = 400): unknown =>
	typeof value === 'string' && value.length > max
		? `${value.slice(0, max)}… [${value.length} chars]`
		: value

/** Shrink tool input to what matters for the judgement, capped so one call stays around a few hundred tokens. */
export function summarizeInput(input: unknown): unknown {
	if (!input || typeof input !== 'object') return input ?? null
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(input)) {
		out[key] = key === 'command' || key === 'cmd' ? trim(value, CAP) : trim(value)
	}
	const json = JSON.stringify(out)
	return json.length > CAP * 2 ? trim(json, CAP * 2) : out
}

export type ClassifyArgs = {
	tool: string
	input: unknown
	cwd?: string | undefined
	task?: string | null | undefined
	apiKey?: string | undefined
	timeoutMs?: number | undefined
	signal?: AbortSignal | undefined
}

/** Ask Jev about one tool call. */
export async function classify(args: ClassifyArgs): Promise<Classification> {
	const apiKey = args.apiKey ?? process.env.TYPESAFE_API_KEY
	if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set')
	const started = performance.now()
	const questions: Record<string, unknown> = { ...QUESTIONS }
	if (!args.task) delete questions.in_scope
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 2500)
	args.signal?.addEventListener('abort', () => controller.abort(), { once: true })
	try {
		const response = await fetch('https://api.typesafe.ai/v1/systemone', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'jev-latest',
				state: {
					tool: args.tool,
					input: summarizeInput(args.input),
					cwd: args.cwd ?? null,
					task: args.task ? trim(args.task, 600) : null
				},
				questions
			}),
			signal: controller.signal
		})
		if (!response.ok) {
			throw new Error(`TypeSafe API ${response.status}: ${(await response.text()).slice(0, 200)}`)
		}
		// SAFETY: the API contract for the questions above; a malformed body surfaces as a thrown TypeError at the call site.
		const { answers, usage } = (await response.json()) as ApiResponse
		const level = Math.max(0, Math.min(3, Math.round(answers.risk.score)))
		return {
			tool: args.tool,
			risk: RISK_LEVELS[level] ?? 'hard_to_reverse',
			riskScore: answers.risk.score,
			riskConfidence: answers.risk.confidence,
			category: answers.category.choice,
			categoryConfidence: answers.category.confidence,
			secrets: answers.secrets.noul,
			outsideProject: answers.outside_project.noul,
			inScope: answers.in_scope ? answers.in_scope.noul : null,
			ms: Math.round(performance.now() - started),
			inputTokens: usage.input_tokens
		}
	} finally {
		clearTimeout(timer)
	}
}

const label = (risk: RiskLevel): string => risk.replace(/_/g, ' ')

/** Turn a classification into allow / ask / deny. Code owns the policy; the model only judged. */
export function decide(c: Classification, policy: Policy = POLICY): Verdict {
	const level = RISK_LEVELS.indexOf(c.risk)
	if (c.secrets >= policy.secrets) {
		return { decision: 'ask', reason: `may read or expose credentials (${c.secrets.toFixed(2)})` }
	}
	if (level === 3 && c.riskConfidence >= policy.destructiveConfidence) {
		if (c.inScope !== null && c.inScope < policy.inScope) {
			return {
				decision: 'deny',
				reason: `destructive and not part of the current task (in scope ${c.inScope.toFixed(2)})`
			}
		}
		return { decision: 'ask', reason: `destructive (${c.riskConfidence.toFixed(2)})` }
	}
	if (level >= 2)
		return { decision: 'ask', reason: `${label(c.risk)} (${c.riskConfidence.toFixed(2)})` }
	if (c.outsideProject >= policy.outsideProject && level >= 1) {
		return {
			decision: 'ask',
			reason: `writes outside the project (${c.outsideProject.toFixed(2)})`
		}
	}
	if (c.riskConfidence >= policy.allowConfidence) {
		return {
			decision: 'allow',
			reason: `${label(c.risk)} ${c.category} (${c.riskConfidence.toFixed(2)})`
		}
	}
	return {
		decision: 'ask',
		reason: `unsure: ${label(c.risk)} at ${c.riskConfidence.toFixed(2)} confidence`
	}
}

export const describe = (c: Classification, v: Verdict): string =>
	`jev ${v.decision} · ${v.reason} · ${c.ms}ms · ${c.inputTokens} tok`

const LOG_DIR = join(homedir(), '.jev-guard')

/** Append one JSON line per decision to ~/.jev-guard/log.jsonl. Never throws. */
export function logDecision(entry: Record<string, JsonValue | unknown>): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true })
		appendFileSync(
			join(LOG_DIR, 'log.jsonl'),
			`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
		)
	} catch {
		// Logging must never break the tool call.
	}
}
