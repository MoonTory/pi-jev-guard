/**
 * jev-guard: classify every tool call with TypeSafe's Jev before it runs.
 *
 * Jev is a System One model: no text, only typed answers with confidence, in ~300 ms.
 * One request asks how hard the call is to undo, what kind of action it is, whether it
 * touches secrets or files outside the project, and whether it serves the user's task.
 * Code turns those answers into allow / ask / deny. See classify.ts for the questions
 * and thresholds.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent'

import {
	classify,
	decide,
	describe,
	logDecision,
	type Classification,
	type Verdict
} from './classify.ts'

type Mode = 'enforce' | 'log' | 'off'

type Config = {
	mode: Mode
	skipTools: string[] // tools that never need a judgement; saves a round trip
	timeoutMs: number
	failOpen: boolean // API error or timeout: true = let the call run, false = block it
	askWithoutUi: 'block' | 'allow' // what an "ask" becomes in print / RPC mode with no one to ask
	showStatus: boolean
}

type Stats = {
	calls: number
	allow: number
	ask: number
	deny: number
	errors: number
	ms: number
	tokens: number
}

type Block = { block: true; reason: string }

const DEFAULTS: Config = {
	mode: 'enforce',
	skipTools: ['read', 'grep', 'find', 'ls'],
	timeoutMs: 2500,
	failOpen: true,
	askWithoutUi: 'block',
	showStatus: true
}

const CONFIG_FILE = join(homedir(), '.pi', 'agent', 'jev-guard.json')

const PRICE_PER_MTOK = 0.042

function loadConfig(): Config {
	try {
		// SAFETY: the file is the user's own settings; unknown keys are harmless and missing ones fall back to DEFAULTS.
		const fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>
		return { ...DEFAULTS, ...fromFile }
	} catch {
		// No config file, or an unreadable one: run with defaults.
		return { ...DEFAULTS }
	}
}

/** Text of the most recent user message on the current branch, so Jev can judge scope. */
function currentTask(ctx: ExtensionContext): string | null {
	for (const entry of ctx.sessionManager.getBranch().toReversed()) {
		if (entry.type !== 'message' || entry.message.role !== 'user') continue
		const content = entry.message.content
		if (typeof content === 'string') return content
		const text = content
			.map((part: { type: string; text?: string }) =>
				part.type === 'text' ? (part.text ?? '') : ''
			)
			.join(' ')
			.trim()
		return text || null
	}
	return null
}

function describeCall(event: ToolCallEvent): string {
	if (event.toolName === 'bash') return String(event.input.command)
	return JSON.stringify(event.input).slice(0, 400)
}

function errorVerdict(config: Config, message: string): Block | undefined {
	if (config.failOpen) return undefined
	return {
		block: true,
		reason: `jev-guard could not classify this call (${message}) and failOpen is false`
	}
}

async function askHuman(
	config: Config,
	ctx: ExtensionContext,
	event: ToolCallEvent,
	verdict: Verdict
): Promise<Block | undefined> {
	if (!ctx.hasUI) {
		if (config.askWithoutUi === 'allow') return undefined
		return {
			block: true,
			reason: `jev-guard needs a human for this call (${verdict.reason}) and no one is here. Ask the user first.`
		}
	}
	const ok = await ctx.ui.confirm(
		`jev-guard: ${verdict.reason}`,
		`${event.toolName}: ${describeCall(event)}\n\nRun it?`
	)
	if (ok) return undefined
	return { block: true, reason: `The user declined this call (${verdict.reason}).` }
}

function report(config: Config, stats: Stats, ctx: ExtensionContext): void {
	const avg = stats.calls ? Math.round(stats.ms / stats.calls) : 0
	const cost = ((stats.tokens / 1e6) * PRICE_PER_MTOK).toFixed(4)
	ctx.ui.notify(
		`jev-guard ${config.mode} · ${stats.calls} calls · allow ${stats.allow} ask ${stats.ask} deny ${stats.deny} errors ${stats.errors} · avg ${avg}ms · ${stats.tokens.toLocaleString()} tokens ($${cost}) · log ~/.jev-guard/log.jsonl`,
		'info'
	)
}

type Guard = {
	config: Config
	stats: Stats
	setStatus: (ctx: ExtensionContext, text?: string) => void
	guard: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<Block | undefined>
}

/** Everything that needs the shared config and stats, built once per extension load. */
function createGuard(): Guard {
	const config = loadConfig()
	let warnedNoKey = false
	const stats: Stats = { calls: 0, allow: 0, ask: 0, deny: 0, errors: 0, ms: 0, tokens: 0 }

	const setStatus = (ctx: ExtensionContext, text?: string): void => {
		if (ctx.hasUI && config.showStatus) ctx.ui.setStatus('jev-guard', text)
	}

	const record = (c: Classification, verdict: Verdict): void => {
		stats.calls++
		stats.ms += c.ms
		stats.tokens += c.inputTokens
		stats[verdict.decision]++
	}

	const guard = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<Block | undefined> => {
		if (config.mode === 'off' || config.skipTools.includes(event.toolName)) return undefined
		if (!process.env.TYPESAFE_API_KEY) {
			if (!warnedNoKey && ctx.hasUI) {
				ctx.ui.notify('jev-guard: TYPESAFE_API_KEY is not set, guard is inactive', 'warning')
				warnedNoKey = true
			}
			return undefined
		}

		let c: Classification
		try {
			c = await classify({
				tool: event.toolName,
				input: event.input,
				cwd: ctx.cwd,
				task: currentTask(ctx),
				timeoutMs: config.timeoutMs,
				signal: ctx.signal
			})
		} catch (err) {
			stats.errors++
			const message = err instanceof Error ? err.message : String(err)
			logDecision({ harness: 'pi', tool: event.toolName, error: message })
			setStatus(ctx, `jev-guard error: ${message.slice(0, 60)}`)
			return errorVerdict(config, message)
		}

		const verdict = decide(c)
		record(c, verdict)
		logDecision({ harness: 'pi', mode: config.mode, input: event.input, ...c, ...verdict })
		setStatus(ctx, describe(c, verdict))
		if (config.mode === 'log' || verdict.decision === 'allow') return undefined
		if (verdict.decision === 'deny') {
			return {
				block: true,
				reason: `jev-guard blocked this call: ${verdict.reason}. Pick a safer way or ask the user.`
			}
		}
		return askHuman(config, ctx, event, verdict)
	}

	return { config, stats, setStatus, guard }
}

export default function (pi: ExtensionAPI) {
	const g = createGuard()

	pi.on('session_start', (_event, ctx) => {
		Object.assign(g.config, loadConfig())
		g.setStatus(ctx, g.config.mode === 'off' ? undefined : `jev-guard ${g.config.mode}`)
	})

	pi.on('tool_call', g.guard)

	pi.registerCommand('jev-guard', {
		description: 'jev-guard: off | log | enforce | stats',
		handler: async (args, ctx) => {
			const mode = (args ?? '').trim()
			if (mode !== 'off' && mode !== 'log' && mode !== 'enforce') {
				report(g.config, g.stats, ctx)
				return
			}
			g.config.mode = mode
			g.setStatus(ctx, mode === 'off' ? undefined : `jev-guard ${mode}`)
			ctx.ui.notify(`jev-guard mode: ${mode}`, 'info')
		}
	})
}
