import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'manual-retry': {
      readonly kind: 'manual-retry'
      readonly turn: number
      readonly endSeq: number
    }
  }
}

export interface ContinuationTarget {
  readonly turn: number
  readonly endSeq: number
  readonly reason: 'error' | 'user-aborted'
}

interface OpenTurn {
  readonly turn: number
  readonly committed: boolean
  readonly unsafe: boolean
  readonly pending: readonly string[]
}

interface ClosedTurn {
  readonly turn: number
  readonly endSeq: number
  readonly refusal: string | null
  readonly target: ContinuationTarget | null
}

interface RetryState {
  readonly open: OpenTurn | null
  readonly closed: ClosedTurn | null
}

const FAILURE_TEXT = 'The previous task failed before completion. Continue the unfinished work using the existing conversation and tool results. Do not restart completed steps or blindly repeat side-effecting commands. Before repeating a command that may already have run, verify the external state; if it cannot be verified safely, ask the user.'
const ABORT_TEXT = 'The user stopped the previous task before it finished. Continue that same unfinished task using the existing conversation and tool results. Do not undo completed work, restart completed steps, or change the plan. Do not blindly repeat side-effecting commands. Before repeating a command that may already have run, verify the external state; if it cannot be verified safely, ask the user.'
const NO_TARGET = 'There is no failed or stopped turn to continue.'
const NO_COMMITTED = 'That turn has no committed task to continue.'
const UNSAFE = 'A tool in that turn has an unsettled effect. Continue was not queued. Check the external state, then send a new message.'
const MAX_TOKENS = 'This turn ran out of output tokens. Continue is not available. Send a new message.'
const CRASH = 'This turn was interrupted by a crash. Continue is not available.'
const SYSTEM_CANCEL = 'This turn was cancelled by the system. Continue is not available.'
const BLOCKED = 'This turn was blocked. Continue is not available. Send a new message.'
const FORKED = 'This turn was forked. Continue is not available.'
const FINISHED = 'That turn finished. There is nothing to continue.'
const INVALID_TURN = 'The turn number is not valid. Continue was not queued.'
const BUSY = 'The agent is busy. Continue was not queued.'
const WAITING = 'A message is already waiting. Continue was not queued.'
const NO_MODEL = 'No model is selected. Continue was not queued.'
const NOT_DRIVEN = 'Continue is only available in the session you are driving.'
const CANCELLED = 'Continue was cancelled before it was queued.'
const NAMED_MISS = 'That turn is not the latest continuable turn. Continue was not queued.'
const UNSAFE_CODES = new Set(['TOOL_OUTCOME_UNKNOWN', 'TOOL_TIMEOUT', 'ABORTED'])

const openSchema = z.object({
  turn: z.number(),
  committed: z.boolean(),
  unsafe: z.boolean(),
  pending: z.array(z.string()),
})
const targetSchema = z.object({
  turn: z.number(),
  endSeq: z.number(),
  reason: z.enum(['error', 'user-aborted']),
})
const stateSchema = z.object({
  open: openSchema.nullable(),
  closed: z.object({
    turn: z.number(),
    endSeq: z.number(),
    refusal: z.string().nullable(),
    target: targetSchema.nullable(),
  }).nullable(),
})

export const name = 'retry'
export const inject = ['commands', 'sessionProjections'] as const

interface ProjectionRegistry {
  register(definition: {
    key: 'retry'
    stateVersion: number
    stateSchema: z.ZodType<RetryState>
    init: () => RetryState
    apply: (state: RetryState, event: SessionEvent) => RetryState
    wire: {
      viewSchema: z.ZodType<ContinuationTarget | null>
      view: (state: RetryState) => ContinuationTarget | null
    }
  }): () => void
  stateOf(session: Agent['session'], key: 'retry'): RetryState | undefined
}

function projections(ctx: Context): ProjectionRegistry {
  return (ctx as Context & { sessionProjections: ProjectionRegistry }).sessionProjections
}

/** Host plugin: one `/retry` command and the Continuation projection it reads. */
export function apply(ctx: Context): void {
  projections(ctx).register({
    key: 'retry',
    stateVersion: 1,
    stateSchema,
    init: () => ({ open: null, closed: null }),
    apply: fold,
    wire: {
      viewSchema: targetSchema.nullable(),
      view: (state) => state.closed?.target ?? null,
    },
  })
  ctx.commands.register({
    name: 'retry',
    description: 'Continue the most recent failed or stopped task.',
    handler: (invocation) => handle(ctx, invocation),
  })
}

function handle(ctx: Context, invocation: CommandInvocation): CommandResult | Promise<CommandResult> {
  if (invocation.signal.aborted) return refuse(CANCELLED)
  if (!driven(invocation.agent)) return refuse(NOT_DRIVEN)
  if (invocation.agent.status !== 'idle') return refuse(BUSY)
  try {
    return invocation.agent.runMaintenance((signal) => Promise.resolve(admit(ctx, invocation, signal)))
  } catch {
    return refuse(BUSY)
  }
}

function admit(ctx: Context, invocation: CommandInvocation, signal: AbortSignal): CommandResult {
  if (invocation.signal.aborted || signal.aborted) return refuse(CANCELLED)
  const agent = invocation.agent
  if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return refuse(WAITING)
  const named = parseTurn(invocation.rawInput)
  if (named === 'invalid') return refuse(INVALID_TURN)
  if (!agent.options.provider || !agent.options.model) return refuse(NO_MODEL)
  const closed = projections(ctx).stateOf(agent.session, 'retry')?.closed ?? null
  const target = closed?.target ?? null
  if (named !== 'latest' && target?.turn !== named) return refuse(NAMED_MISS)
  if (!target) return refuse(closed?.refusal ?? NO_TARGET)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: target.reason === 'user-aborted' ? ABORT_TEXT : FAILURE_TEXT }],
    source: { kind: 'manual-retry', turn: target.turn, endSeq: target.endSeq },
  }))
  return { kind: 'success', text: `Continuation queued for turn ${target.turn}. This does not mean the work has finished.` }
}

function driven(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

function parseTurn(raw: string): 'latest' | 'invalid' | number {
  const text = raw.trim()
  if (text === '') return 'latest'
  const match = /^--turn=(\d+)$/.exec(text)
  return match ? Number(match[1]) : 'invalid'
}

function refuse(text: string): CommandResult {
  return { kind: 'error', text }
}

function fold(state: RetryState, event: SessionEvent): RetryState {
  if (event.type === 'turn/start') {
    return { open: { turn: event.data.turn, committed: false, unsafe: false, pending: [] }, closed: null }
  }
  const open = state.open
  if (!open) return state
  if (event.type === 'user/message') {
    const kind = event.data.source.kind
    if ((kind !== 'user' && kind !== 'manual-retry') || open.committed) return state
    return { ...state, open: { ...open, committed: true } }
  }
  if (event.type === 'tool/call') {
    if (event.data.turn !== open.turn) return state
    return { ...state, open: { ...open, pending: [...open.pending, String(event.data.callId)] } }
  }
  if (event.type === 'tool/result') {
    if (event.data.turn !== open.turn) return state
    const code = event.data.error?.code
    return {
      ...state,
      open: {
        ...open,
        unsafe: open.unsafe || (code !== undefined && UNSAFE_CODES.has(code)),
        pending: open.pending.filter((id) => id !== String(event.data.message.toolCallId)),
      },
    }
  }
  if (event.type !== 'turn/end' || event.data.turn !== open.turn) return state
  return { open: null, closed: closeTurn(open, event) }
}

function closeTurn(open: OpenTurn, event: SessionEvent<'turn/end'>): ClosedTurn {
  const endSeq = Number(event.seq)
  if (open.unsafe || open.pending.length > 0) return { turn: open.turn, endSeq, refusal: UNSAFE, target: null }
  const ending = endingRefusal(event.data.reason)
  if (ending) return { turn: open.turn, endSeq, refusal: ending, target: null }
  if (!open.committed) return { turn: open.turn, endSeq, refusal: NO_COMMITTED, target: null }
  const reason = event.data.reason.kind === 'aborted' ? 'user-aborted' as const : 'error' as const
  return { turn: open.turn, endSeq, refusal: null, target: { turn: open.turn, endSeq, reason } }
}

function endingRefusal(reason: SessionEvent<'turn/end'>['data']['reason']): string | null {
  switch (reason.kind) {
    case 'error':
      return null
    case 'aborted':
      return reason.reason.kind === 'user' ? null : SYSTEM_CANCEL
    case 'max-tokens':
      return MAX_TOKENS
    case 'interrupted':
      return CRASH
    case 'blocked':
      return BLOCKED
    case 'forked':
      return FORKED
    case 'completed':
      return FINISHED
    default:
      return NO_TARGET
  }
}
