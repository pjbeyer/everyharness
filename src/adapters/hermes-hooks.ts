// Hermes hooks translation layer: maps the Claude-format hooks.json everyharness
// consumes (the same file claude-code/cursor emit) onto Hermes' native plugin
// hook surface. Kept separate from hermes.ts so the translation is testable on
// its own and the adapter stays a thin emitter.
//
// Verified against installed hermes-agent source 2026-11-03 (see evh-4wb.1):
//   PreToolUse   -> pre_tool_call          (fail-closed gate: {action: block, message} vetoes)
//   PostToolUse  -> post_tool_call         (observer: status/error_type/error_message; returns ignored)
//                  + transform_tool_result when the hook rewrites output (updatedToolOutput)
//   SessionStart -> on_session_start       (observer; return values IGNORED by Hermes —
//                                            additionalContext cannot be injected here)
//   SessionEnd   -> on_session_end         (observer; Claude gives it no decision control either)
//
// Every other Claude hook event (UserPromptSubmit, Stop, Notification, ...)
// has no Hermes analog: each fires a per-event warning at generate time
// (honest degradation per Design decision 1), never a silent drop.

export type HermesHookEvent =
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'transform_tool_result'
  | 'on_session_start'
  | 'on_session_end'

export interface TranslatedHook {
  /** The Hermes hook event this entry registers under. */
  event: HermesHookEvent
  /** Claude matcher regex; honored at runtime only for tool events. */
  matcher?: string
  /** The shell commands to run, in declaration order. */
  commands: string[]
  /** Per-entry timeout in seconds (Claude default 60). */
  timeout?: number
}

export interface TranslationResult {
  hooks: TranslatedHook[]
  /** One warning per unmapped Claude event / unusable entry. */
  warnings: string[]
}

// Claude event name -> Hermes event name. A single Claude event can map to a
// Hermes event pair (PostToolUse observes AND can rewrite); the pair is
// expressed as one TranslatedHook per Hermes event sharing the same commands.
const EVENT_MAP: Record<string, HermesHookEvent[]> = {
  PreToolUse: ['pre_tool_call'],
  PostToolUse: ['post_tool_call', 'transform_tool_result'],
  SessionStart: ['on_session_start'],
  SessionEnd: ['on_session_end'],
}

// Claude hooks.json shape: { hooks: { <EventName>: [ { matcher?, hooks: [{ type, command, timeout? }] } ] } }
interface ClaudeHookEntry {
  matcher?: unknown
  hooks?: unknown
}

// Whether a PostToolUse command could rewrite the tool result. Only
// updatedToolOutput-bearing output can; the observer bridge cannot translate
// output at all, so only the transform hook consults this. We cannot know at
// generate time what a script will print, so transform_tool_result is ALWAYS
// registered alongside post_tool_call when any PostToolUse hook exists — the
// runtime bridge returns None (unchanged) unless the script emitted an
// updatedToolOutput JSON payload.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function commandsOf(entry: ClaudeHookEntry, warnings: string[], event: string): { commands: string[]; timeout?: number } {
  const commands: string[] = []
  let timeout: number | undefined
  if (!Array.isArray(entry.hooks)) {
    warnings.push(`hermes hooks: ${event} entry has no hooks array; skipped`)
    return { commands }
  }
  for (const h of entry.hooks) {
    if (!isPlainObject(h)) continue
    const command = h.command
    if (typeof command !== 'string' || !command.trim()) {
      warnings.push(`hermes hooks: ${event} entry has a hook without a command; skipped`)
      continue
    }
    commands.push(command)
    const t = h.timeout
    if (typeof t === 'number' && Number.isFinite(t) && t >= 1) timeout = t
  }
  return { commands, timeout }
}

export function translateClaudeHooks(userHooks: unknown): TranslationResult {
  const hooks: TranslatedHook[] = []
  const warnings: string[] = []
  if (userHooks === undefined) return { hooks, warnings }
  if (!isPlainObject(userHooks)) {
    warnings.push('hermes hooks: hooks.json must be a JSON object; ignored')
    return { hooks, warnings }
  }
  const doc = userHooks as { hooks?: unknown }
  const byEvent = doc.hooks
  if (!isPlainObject(byEvent)) {
    warnings.push('hermes hooks: hooks.json has no hooks object; ignored')
    return { hooks, warnings }
  }
  // Iterate Claude event names in declaration order for deterministic output.
  for (const [claudeEvent, rawEntries] of Object.entries(byEvent)) {
    const hermesEvents = EVENT_MAP[claudeEvent]
    if (!hermesEvents) {
      warnings.push(`hermes hooks: Claude event ${claudeEvent} has no Hermes analog; not emitted`)
      continue
    }
    if (!Array.isArray(rawEntries)) continue
    for (const raw of rawEntries) {
      if (!isPlainObject(raw)) continue
      const entry = raw as ClaudeHookEntry
      const { commands, timeout } = commandsOf(entry, warnings, claudeEvent)
      if (!commands.length) continue
      const translated: TranslatedHook = { event: hermesEvents[0], commands }
      if (typeof entry.matcher === 'string' && entry.matcher.trim()) translated.matcher = entry.matcher
      if (timeout !== undefined) translated.timeout = timeout
      hooks.push(translated)
      // PostToolUse's second face: the same commands registered under
      // transform_tool_result so an updatedToolOutput payload can replace the
      // result (the observer face alone cannot rewrite).
      if (hermesEvents.length > 1) {
        const second: TranslatedHook = { event: hermesEvents[1], commands }
        if (translated.matcher) second.matcher = translated.matcher
        if (timeout !== undefined) second.timeout = timeout
        hooks.push(second)
      }
    }
  }
  return { hooks, warnings }
}

/** Sorted unique Hermes hook names for provides_hooks (drift-proof derivation). */
export function hermesHookNames(hooks: TranslatedHook[]): HermesHookEvent[] {
  return [...new Set(hooks.map((h) => h.event))].sort()
}
