import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader, TurnEndReason } from '@deepseek-ai/dsh-session'
import * as retry from '../lib/index.js'

const FAILURE_TEXT = 'The previous task failed before completion. Continue the unfinished work using the existing conversation and tool results. Do not restart completed steps or blindly repeat side-effecting commands. Before repeating a command that may already have run, verify the external state; if it cannot be verified safely, ask the user.'
const ABORT_TEXT = 'The user stopped the previous task before it finished. Continue that same unfinished task using the existing conversation and tool results. Do not undo completed work, restart completed steps, or change the plan. Do not blindly repeat side-effecting commands. Before repeating a command that may already have run, verify the external state; if it cannot be verified safely, ask the user.'
const NO_TARGET = 'There is no failed or stopped turn to continue.'
const NO_COMMITTED = 'That turn has no committed task to continue.'
const UNSAFE = 'A tool in that turn has an unsettled effect. Continue was not queued. Check the external state, then send a new message.'
const MAX_TOKENS = 'This turn ran out of output tokens. Continue is not available. Send a new message.'
const INTERRUPTED = 'This turn was interrupted by a crash. Continue is not available.'
const SYSTEM_CANCEL = 'This turn was cancelled by the system. Continue is not available.'
const BLOCKED = 'This turn was blocked. Continue is not available. Send a new message.'
const FORKED = 'This turn was forked. Continue is not available.'
const FINISHED = 'That turn finished. There is nothing to continue.'
const INVALID = 'The turn number is not valid. Continue was not queued.'
const BUSY = 'The agent is busy. Continue was not queued.'
const WAITING = 'A message is already waiting. Continue was not queued.'
const NO_MODEL = 'No model is selected. Continue was not queued.'
const NOT_DRIVEN = 'Continue is only available in the session you are driving.'
const CANCELLED = 'Continue was cancelled before it was queued.'
const NAMED_MISS = 'That turn is not the latest continuable turn. Continue was not queued.'

interface Setup {
  options?: { provider?: string, model?: string }
  meta?: Pick<SessionHeader, 'cwd' | 'origin' | 'delegationDepth' | 'parentSession'>
}

async function withAgent(run: (agent: Agent) => Promise<void>, setup: Setup = {}): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(retry)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(
    SessionId(`retry-${randomUUID()}`),
    setup.options ?? { provider: 'test', model: 'test-model' },
    setup.meta,
  )
  try {
    await run(agent)
  } finally {
    await ctx.fiber.dispose()
  }
}

function human(session: Session, source: { kind: string } = { kind: 'user' }): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'do the thing' }],
    source,
  }), { surfaceOp: 'append' })
}

function closeTurn(agent: Agent, turn: number, reason: TurnEndReason, source?: { kind: string } | null): void {
  const session = agent.session
  session.append('turn/start', { turn })
  if (source !== null) human(session, source)
  session.append('turn/end', { turn, reason })
}

function failedTurn(agent: Agent): void {
  closeTurn(agent, 1, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })
}

function toolCall(session: Session, callId: string): void {
  session.append('tool/call', { turn: 1, step: 0, callId, name: 'bash', arguments: '{}' })
}

function toolResult(session: Session, callId: string, code?: string): void {
  session.append('tool/result', {
    turn: 1,
    step: 0,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'done' }], isError: code !== undefined },
    ...code === undefined ? {} : { error: { name: 'ToolError', code } },
  }, { surfaceOp: 'append' })
}

function messageText(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.map((block) => block.type === 'text' ? block.text ?? '' : '').join('')
}

function resumeMessages(agent: Agent): { id: string, text: string, source: { kind: string } }[] {
  const found = new Map<string, { id: string, text: string, source: { kind: string } }>()
  const add = (message: { id?: string, content: readonly { type: string, text?: string }[], source?: { kind: string } } | undefined) => {
    if (!message?.id || message.source?.kind !== 'manual-retry') return
    found.set(message.id, { id: message.id, text: messageText(message), source: message.source })
  }
  for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) add(message)
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'user/message') add(event.data)
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted ?? []) add(message)
    }
  }
  return [...found.values()]
}

async function run(agent: Agent, line = '/retry', signal = new AbortController().signal): Promise<CommandExecution | undefined> {
  const commands = agent.ctx.get('commands') as CommandRuntime
  return commands.execute(agent, line, [], signal)
}

test('bare /retry on a Failed Turn queues one failure Resume message', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const before = agent.session.snapshotEvents().map((event) => event.seq)
    const execution = await run(agent)
    assert.equal(execution?.result.kind, 'success')
    assert.equal(execution?.result.text, 'Continuation queued for turn 1. This does not mean the work has finished.')
    const resumes = resumeMessages(agent)
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0]?.text, FAILURE_TEXT)
    assert.equal(resumes[0]?.source.kind, 'manual-retry')
    const after = agent.session.snapshotEvents()
    for (const seq of before) assert.ok(after.some((event) => event.seq === seq))
    assert.equal(after.filter((event) => event.type === 'tool/call').length, 0)
    assert.equal(after.filter((event) => event.type === 'user/message' && event.data.source.kind === 'user').length, 1)
  })
})

test('mounting the plugin does not enqueue a Resume message', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('the command description is the continuation description', async () => {
  await withAgent(async (agent) => {
    const commands = agent.ctx.get('commands') as CommandRuntime
    assert.equal(
      commands.list(agent).find((command) => command.name === 'retry')?.description,
      'Continue the most recent failed or stopped task.',
    )
  })
})

test('an empty session has no Continuation target', async () => {
  await withAgent(async (agent) => {
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: NO_TARGET })
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('a User abort queues the stopped-task Resume message', async () => {
  await withAgent(async (agent) => {
    closeTurn(agent, 1, { kind: 'aborted', reason: { kind: 'user' } })
    const execution = await run(agent)
    assert.equal(execution?.result.kind, 'success')
    const resumes = resumeMessages(agent)
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0]?.text, ABORT_TEXT)
    assert.notEqual(resumes[0]?.text, FAILURE_TEXT)
  })
})

test('a turn with no committed task input is not a target', async () => {
  await withAgent(async (agent) => {
    closeTurn(agent, 1, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, { kind: 'goal' })
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: NO_COMMITTED })
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('an unsettled tool effect refuses and does not queue', async () => {
  const cases: Array<(session: Session) => void> = [
    (session) => toolCall(session, 'missing'),
    (session) => {
      toolCall(session, 'unknown')
      toolResult(session, 'unknown', 'TOOL_OUTCOME_UNKNOWN')
    },
    (session) => {
      toolCall(session, 'timeout')
      toolResult(session, 'timeout', 'TOOL_TIMEOUT')
    },
    (session) => {
      toolCall(session, 'aborted')
      toolResult(session, 'aborted', 'ABORTED')
    },
  ]
  for (const seed of cases) {
    await withAgent(async (agent) => {
      const session = agent.session
      session.append('turn/start', { turn: 1 })
      human(session)
      seed(session)
      session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
      const execution = await run(agent)
      assert.deepEqual(execution?.result, { kind: 'error', text: UNSAFE })
      assert.equal(resumeMessages(agent).length, 0)
    })
  }
})

test('a settled tool error still continues a Failed Turn', async () => {
  const cases: Array<(session: Session) => void> = [
    (session) => {
      toolCall(session, 'before')
      toolResult(session, 'before', 'ABORTED_BEFORE_DISPATCH')
    },
    (session) => {
      toolCall(session, 'not-started')
      toolResult(session, 'not-started', 'TOOL_NOT_STARTED')
    },
    (session) => {
      toolCall(session, 'other')
      toolResult(session, 'other', 'COMMAND_FAILED')
    },
    (session) => toolResult(session, 'orphan', 'COMMAND_FAILED'),
  ]
  for (const seed of cases) {
    await withAgent(async (agent) => {
      const session = agent.session
      session.append('turn/start', { turn: 1 })
      human(session)
      seed(session)
      session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
      const execution = await run(agent)
      assert.equal(execution?.result.kind, 'success')
      assert.equal(resumeMessages(agent)[0]?.text, FAILURE_TEXT)
    })
  }
})

test('ineligible endings name the reason and do not queue', async () => {
  const cases: Array<[TurnEndReason, string]> = [
    [{ kind: 'max-tokens' }, MAX_TOKENS],
    [{ kind: 'interrupted' }, INTERRUPTED],
    [{ kind: 'aborted', reason: { kind: 'parent' } }, SYSTEM_CANCEL],
    [{ kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } }, SYSTEM_CANCEL],
    [{ kind: 'aborted', reason: { kind: 'disposed' } }, SYSTEM_CANCEL],
    [{ kind: 'aborted', reason: { kind: 'legacy' } }, SYSTEM_CANCEL],
    [{ kind: 'blocked' }, BLOCKED],
    [{ kind: 'forked' }, FORKED],
    [{ kind: 'completed' }, FINISHED],
  ]
  for (const [reason, text] of cases) {
    await withAgent(async (agent) => {
      closeTurn(agent, 1, reason)
      const execution = await run(agent)
      assert.deepEqual(execution?.result, { kind: 'error', text })
      assert.equal(resumeMessages(agent).length, 0)
    })
  }
})

test('a later turn replaces the previous Continuation target', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    agent.session.append('turn/start', { turn: 2 })
    const execution = await run(agent)
    assert.notEqual(execution?.result.kind, 'success')
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('a command record after the target does not remove it', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    agent.session.append('command/run', { command: 'retry', input: '' })
    const execution = await run(agent)
    assert.equal(execution?.result.kind, 'success')
  })
})

test('a compaction marker after the target does not remove it', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    human(agent.session, { kind: 'compact-checkpoint' })
    const execution = await run(agent)
    assert.equal(execution?.result.kind, 'success')
    assert.equal(resumeMessages(agent)[0]?.text, FAILURE_TEXT)
  })
})

test('an exact --turn= still continues that target', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const execution = await run(agent, '/retry --turn=1')
    assert.equal(execution?.result.kind, 'success')
    assert.equal(resumeMessages(agent).length, 1)
  })
})

test('a named Turn that is not the target is refused as a miss', async () => {
  await withAgent(async (agent) => {
    closeTurn(agent, 1, { kind: 'completed' })
    const named = await run(agent, '/retry --turn=1')
    assert.deepEqual(named?.result, { kind: 'error', text: NAMED_MISS })
    const bare = await run(agent)
    assert.deepEqual(bare?.result, { kind: 'error', text: FINISHED })
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('a Turn argument that is not one number is invalid', async () => {
  const lines = ['/retry --turn=', '/retry --turn=-1', '/retry --turn=1.5', '/retry --turn=1 extra', '/retry foo', '/retry --turn=1 --turn=2']
  for (const line of lines) {
    await withAgent(async (agent) => {
      failedTurn(agent)
      const execution = await run(agent, line)
      assert.deepEqual(execution?.result, { kind: 'error', text: INVALID })
      assert.equal(resumeMessages(agent).length, 0)
    })
  }
})

test('a waiting message outranks Continue', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'already waiting' }], source: { kind: 'user' } }))
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: WAITING })
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('a busy agent is refused before a Resume message is queued', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const deadline = Date.now() + 500
    while (agent.status !== 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(agent.status, 'running')
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: BUSY })
    assert.equal(resumeMessages(agent).filter((message) => message.text === FAILURE_TEXT).length, 0)
  })
})

test('a claimed Resume message still reserves that turn', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const end = agent.session.snapshotEvents().find((event) => event.type === 'turn/end')
    assert.ok(end)
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [createUserMessage({
        content: [{ type: 'text', text: FAILURE_TEXT }],
        source: { kind: 'manual-retry', turn: 1, endSeq: Number(end.seq) },
      })],
    })
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: 'A message is already waiting. Continue was not queued.' })
    assert.equal(resumeMessages(agent).length, 1)
  })
})

test('a second activation does not queue another Resume message', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const first = await run(agent)
    assert.equal(first?.result.kind, 'success')
    const second = await run(agent)
    assert.notEqual(second?.result.kind, 'success')
    assert.equal(resumeMessages(agent).length, 1)
  })
})

test('no selected model refuses before a named miss', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const execution = await run(agent, '/retry --turn=9')
    assert.deepEqual(execution?.result, { kind: 'error', text: NO_MODEL })
    assert.equal(resumeMessages(agent).length, 0)
  }, { options: {} })
})

test('an invalid Turn argument outranks a missing model', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const execution = await run(agent, '/retry --turn=nope')
    assert.deepEqual(execution?.result, { kind: 'error', text: INVALID })
  }, { options: {} })
})

test('a waiting message outranks an invalid Turn argument', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'waiting' }], source: { kind: 'user' } }))
    const execution = await run(agent, '/retry --turn=nope')
    assert.deepEqual(execution?.result, { kind: 'error', text: WAITING })
  })
})

test('an already-cancelled request does not queue', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    await assert.rejects(run(agent, '/retry', AbortSignal.abort()))
    assert.equal(resumeMessages(agent).length, 0)
  })
})

test('a subagent session is not a driven session', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const execution = await run(agent)
    assert.deepEqual(execution?.result, { kind: 'error', text: NOT_DRIVEN })
    assert.equal(resumeMessages(agent).length, 0)
  }, { meta: { origin: 'subagent', delegationDepth: 1 } })
})

test('a fork with a parent session is still a driven session', async () => {
  await withAgent(async (agent) => {
    failedTurn(agent)
    const execution = await run(agent)
    assert.equal(execution?.result.kind, 'success')
  }, { meta: { parentSession: SessionId('parent') } })
})
