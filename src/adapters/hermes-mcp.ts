import type { PluginModel } from '../model.js'
import { ConfigError } from '../config.js'

// Hermes MCP emission — the shared translation and declaration plumbing for
// the hermes adapter and the agent-plugins-1.0 adapter (which owns the root
// plugin.json where Hermes reads the server declarations from).
//
// Ground truth (verified 2026-11-04 against installed hermes-agent source
// plus hermetic PluginManager probes):
//
// - Hermes consumes MCP config ONLY through the Agent Plugins v1 portable
//   package mechanism (root mcp.json + plugin.json extensions); there is no
//   ctx.register API for MCP servers.
// - mcp.json's top level is EXACTLY {$schema, mcpServers}
//   (agent_plugins._discover_mcp: any other shape is a hard diagnostic).
//   $schema must be the v1 mcp.schema.json URL.
// - Server types: stdio (type/command/args/env/cwd) and streamable-http
//   (type/url/headers). `sse` is explicitly REJECTED by Hermes. Unknown
//   types are rejected. We mirror that rejection at generate time (below)
//   so an sse server is a pointed ConfigError naming the fix, not a load
//   -time diagnostic that silently drops the whole server set.
// - Server naming: portable_mcp_server_name returns just the slug of the
//   mcp.json server name (the plugin identity is deliberately NOT part of
//   the name — it would hash-clamp the tool verb under provider 64-char
//   caps). A duplicate name is refused at load: native config first, then
//   first-loaded plugin.
// - Native config.yaml wins on a name clash; the portable entry only
//   carries its declared cost keys over when the native entry lacks them.
// - `${VAR}` interpolation is RUNTIME: the portable translation expands
//   only PLUGIN_ROOT/PLUGIN_DATA; user ${VAR} values pass through
//   literally and resolve from the profile's secret scope at config load.
//   Remote servers still carrying a literal ${VAR} after rendering fail
//   closed (missing_credentials). Secrets therefore stay env-injected —
//   mcp.json must never carry literal secret values.
// - Server declarations live in plugin.json under
//   extensions."com.nousresearch.hermes".servers.<name> with keys from
//   _SERVER_DECLARATION_KEYS {app, requires, liveness, trust, timeout,
//   costs, spend_limit, cost_unit}; a declaration naming a server with no
//   mcp.json entry is a hard AgentPluginError — enforced here at generate
//   time for the same fail-loud reason.

export const HERMES_EXTENSION_KEY = 'com.nousresearch.hermes'
export const MCP_SCHEMA_V1 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// The everyharness source MCP config (model.mcp) is a Claude-flavored
// {mcpServers: {...}} document. Servers with a `command` are stdio; servers
// with a `url` are remote (Claude's `type: sse` maps to Hermes' REJECTED sse
// transport, so it is an error here, matching Hermes' own behavior).
// Output must stay BYTE-IDENTICAL to agent-plugins.ts's mcpManifest() so
// generate's dedupe collapses the two emissions into one file.
export interface McpTranslation {
  manifest?: Record<string, unknown>
  warnings: string[]
}

export function translateMcpForHermes(model: PluginModel): McpTranslation {
  const mcp = model.mcp
  const warnings: string[] = []
  if (mcp === undefined) return { warnings }
  if (!isPlainObject(mcp) || !isPlainObject(mcp.mcpServers)) {
    return { warnings: ['mcp config has no mcpServers object; nothing translated for hermes'] }
  }

  const mcpServers: Record<string, unknown> = {}
  for (const [name, source] of Object.entries(mcp.mcpServers)) {
    if (!isPlainObject(source)) {
      warnings.push(`mcp server "${name}" could not be translated; skipped`)
      continue
    }
    if (typeof source.command === 'string') {
      // stdio: single executable token (bare name or ./-prefixed), args,
      // env (PLUGIN_ROOT/PLUGIN_DATA reserved), optional cwd — same rules
      // as agent-plugins.ts, which this output must stay byte-identical
      // with so generate's dedupe collapses the two emissions.
      const { entry, warnings: serverWarnings } = translateStdioServer(name, source)
      warnings.push(...serverWarnings)
      if (entry) mcpServers[name] = entry
    } else if (typeof source.url === 'string') {
      if (source.type === 'sse') {
        // Hermes rejects portable sse at load with a diagnostic that drops
        // the server; fail earlier and louder here.
        throw new ConfigError(
          `mcp server "${name}" uses the sse transport, which Hermes' portable MCP loader rejects`,
          ['use "streamable-http" (Agent Plugins v1 §7.2.1) or remove the server'],
        )
      }
      const entry: Record<string, unknown> = { type: 'streamable-http', url: source.url }
      if (isPlainObject(source.headers)) entry.headers = source.headers
      mcpServers[name] = entry
    } else {
      warnings.push(`mcp server "${name}" has neither command nor url; skipped`)
    }
  }
  if (!Object.keys(mcpServers).length) return { warnings }
  return { manifest: { $schema: MCP_SCHEMA_V1, mcpServers }, warnings }
}

// Mirrors agent-plugins.ts's stdio rules exactly — see the byte-identical
// requirement in translateMcpForHermes. Reserved env keys and invalid
// commands are warned-and-dropped there; the same here.
const RESERVED_ENV_KEYS = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA'])

function isValidStdioCommand(command: string): boolean {
  if (/\s/.test(command)) return false
  if (command.startsWith('./')) return true
  return !command.includes('/')
}

function translateStdioServer(
  name: string,
  source: Record<string, unknown>,
): { entry?: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  if (!isValidStdioCommand(source.command as string)) {
    warnings.push(`mcp server "${name}" command is not a single executable token; skipped`)
    return { warnings }
  }
  const entry: Record<string, unknown> = { type: 'stdio', command: source.command }
  if (Array.isArray(source.args)) entry.args = source.args
  if (isPlainObject(source.env)) {
    const env: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source.env)) {
      if (RESERVED_ENV_KEYS.has(key)) {
        warnings.push(`mcp server "${name}" env key "${key}" is reserved by Agent Plugins; dropped`)
        continue
      }
      env[key] = value
    }
    if (Object.keys(env).length) entry.env = env
  }
  if (typeof source.cwd === 'string') entry.cwd = source.cwd
  return { entry, warnings }
}

// The server declarations from harnesses.hermes.servers, validated against
// the mcp.json server set: a declaration without a matching mcp.json server
// is a hard error (mirrors Hermes' own AgentPluginError — but at generate
// time, where the author can fix it, instead of at install time).
export function hermesServerDeclarations(model: PluginModel): Record<string, Record<string, unknown>> {
  const servers = model.config.harnesses.settings['hermes']?.servers
  if (!servers || !Object.keys(servers).length) return {}
  const mcp = model.mcp
  const mcpServerNames = isPlainObject(mcp) && isPlainObject(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : []
  const orphans = Object.keys(servers).filter((name) => !mcpServerNames.includes(name))
  if (orphans.length) {
    throw new ConfigError(
      `harnesses.hermes.servers declares server(s) with no mcp.json entry: ${orphans.join(', ')}`,
      ['every declaration must name a server that exists in the MCP component config'],
    )
  }
  return servers
}

// Merge the hermes server declarations into a plugin.json manifest's
// extensions block. The caller owns the manifest; this owns the
// "com.nousresearch.hermes" extension key. An existing extensions entry of
// that key from harnesses.agent-plugins-1.0.manifest is respected (its
// servers sub-key wins per-key over the derived declarations, so an author
// can override; a plain-object requirement keeps the schema valid).
export function mergeHermesExtension(
  extensions: Record<string, unknown>,
  declarations: Record<string, Record<string, unknown>>,
): { extensions: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  if (!Object.keys(declarations).length) return { extensions, warnings }
  const merged: Record<string, unknown> = { ...extensions }
  const existing = merged[HERMES_EXTENSION_KEY]
  if (existing !== undefined && !isPlainObject(existing)) {
    warnings.push(`extensions entry "${HERMES_EXTENSION_KEY}" is not an object; hermes server declarations not merged`)
    return { extensions: merged, warnings }
  }
  const hermesExt: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined) }
  const existingServers = hermesExt['servers']
  const servers: Record<string, unknown> =
    isPlainObject(existingServers) ? { ...existingServers } : {}
  for (const [name, declaration] of Object.entries(declarations)) {
    servers[name] = { ...(isPlainObject(servers[name]) ? servers[name] : undefined), ...declaration }
  }
  hermesExt['servers'] = servers
  merged[HERMES_EXTENSION_KEY] = hermesExt
  return { extensions: merged, warnings }
}
