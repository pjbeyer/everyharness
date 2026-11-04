import { describe, it, expect } from 'vitest'
import { translateClaudeHooks, hermesHookNames } from '../../src/adapters/hermes-hooks.js'

describe('translateClaudeHooks', () => {
  it('returns empty for undefined hooks', () => {
    const result = translateClaudeHooks(undefined)
    expect(result.hooks).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('maps each Claude event onto its Hermes event(s)', () => {
    const result = translateClaudeHooks({
      hooks: {
        PreToolUse: [{ matcher: 'terminal', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'observe.sh' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'start.sh' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'end.sh' }] }],
      },
    })
    expect(result.warnings).toEqual([])
    // PostToolUse maps to BOTH the observer and the transform hook so an
    // updatedToolOutput payload can replace the result.
    expect(result.hooks).toEqual([
      { event: 'pre_tool_call', matcher: 'terminal', commands: ['guard.sh'] },
      { event: 'post_tool_call', matcher: '.*', commands: ['observe.sh'] },
      { event: 'transform_tool_result', matcher: '.*', commands: ['observe.sh'] },
      { event: 'on_session_start', commands: ['start.sh'] },
      { event: 'on_session_end', commands: ['end.sh'] },
    ])
  })

  it('carries per-entry timeout and preserves multi-command order', () => {
    const result = translateClaudeHooks({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'a.sh', timeout: 15 }, { type: 'command', command: 'b.sh' }] },
        ],
      },
    })
    expect(result.hooks).toEqual([{ event: 'pre_tool_call', commands: ['a.sh', 'b.sh'], timeout: 15 }])
  })

  it('warns per unmapped Claude event, never drops silently', () => {
    const result = translateClaudeHooks({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'prompt.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
      },
    })
    expect(result.hooks).toEqual([])
    expect(result.warnings).toEqual([
      'hermes hooks: Claude event UserPromptSubmit has no Hermes analog; not emitted',
      'hermes hooks: Claude event Stop has no Hermes analog; not emitted',
    ])
  })

  it('warns on non-object hooks input and missing hooks object', () => {
    expect(translateClaudeHooks('nope').warnings).toEqual([
      'hermes hooks: hooks.json must be a JSON object; ignored',
    ])
    expect(translateClaudeHooks({ nope: true }).warnings).toEqual([
      'hermes hooks: hooks.json has no hooks object; ignored',
    ])
  })

  it('warns on entries without a hooks array or commands', () => {
    const result = translateClaudeHooks({ hooks: { PreToolUse: [{ matcher: 'x' }, { hooks: [{ type: 'command' }] }] } })
    expect(result.hooks).toEqual([])
    expect(result.warnings).toEqual([
      'hermes hooks: PreToolUse entry has no hooks array; skipped',
      'hermes hooks: PreToolUse entry has a hook without a command; skipped',
    ])
  })

  it('ignores a non-array event value silently (same lenience as claude-code)', () => {
    const result = translateClaudeHooks({ hooks: { PreToolUse: 'garbage' } })
    expect(result.hooks).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('drops a matcher that is empty after trimming', () => {
    const result = translateClaudeHooks({
      hooks: { SessionEnd: [{ matcher: '   ', hooks: [{ type: 'command', command: 'end.sh' }] }] },
    })
    expect(result.hooks).toEqual([{ event: 'on_session_end', commands: ['end.sh'] }])
  })
})

describe('hermesHookNames', () => {
  it('derives sorted unique names (no hand-maintained list)', () => {
    const { hooks } = translateClaudeHooks({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'b' }] }, { hooks: [{ type: 'command', command: 'c' }] }],
      },
    })
    expect(hermesHookNames(hooks)).toEqual(['post_tool_call', 'pre_tool_call', 'transform_tool_result'])
  })

  it('returns [] when no hooks translate', () => {
    expect(hermesHookNames([])).toEqual([])
  })
})
