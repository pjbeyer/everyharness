import { stringify } from 'yaml'
import type { GeneratedFile } from '../fileset.js'
import type { PluginModel } from '../model.js'
import type { HarnessAdapter, EmitResult } from './types.js'
import { githubOwnerRepo, json } from './shared.js'
import { bootstrapContentPath } from '../bootstrap/node-package.js'
import { generatedBootstrap, GENERATED_BOOTSTRAP_PATH } from '../bootstrap/generated.js'
import { translateClaudeHooks, hermesHookNames, type TranslatedHook } from './hermes-hooks.js'
import { translateMcpForHermes } from './hermes-mcp.js'

// Hermes' Python plugin module (`.hermes-plugin/__init__.py`), modeled
// directly on superpowers' own `.hermes-plugin/__init__.py`: a two-layout
// `_skills_dir()` probe (git-clone install: `.hermes-plugin/` and
// `<skillsdir>/` are siblings under the plugin root, so this module resolves
// `../<skillsdir>`; flattened install: `<skillsdir>/` sits next to this
// module) that raises loudly when neither layout matches, a
// `_strip_frontmatter` helper, and a `register(ctx)` that registers every
// skill with `ctx.register_skill(name, Path(skill_md))` -- note the
// `Path(...)`, not a plain string: passing a str raises AttributeError and
// hermes silently disables the whole plugin (verified 2026-07-23 against a
// real Hermes install). Bootstrap content is injected via `pre_llm_call`,
// the only documented injection path (on_session_start return values are
// ignored and ctx.inject_message refuses from that hook), gated on
// `is_first_turn` and registered through `ctx.register_hook`.
//
// Deliberately NOT emitted: a Hermes tool-mapping section (superpowers' own
// module documents how its Claude Code-flavored instructions map onto
// Hermes' native tools, e.g. `skill_view(...)`). That content is plugin-
// specific; plugins that want one should put it in their bootstrap skill's
// body instead.
//
// Placeholders: __PLUGIN_NAME__, __SKILLS_DIR__, __BOOTSTRAP_PATH__ (only
// used when bootstrap is active).
// Hooks bridge: emitted when everyharness.yaml declares a hooks component.
// Translates Claude-format hook events onto Hermes' native hook surface at
// RUNTIME (Hermes config-level hooks use Hermes event names, so the
// translation cannot happen at generate time for user-managed config; the
// plugin bridges instead). The generated Python below is verified against
// installed hermes-agent source 2026-11-03:
//
//   pre_tool_call        fail-closed gate; {action: block, message} vetoes
//   post_tool_call       observer (status/error_type/error_message)
//   transform_tool_result replacement string or None (unchanged)
//   on_session_start     observer (Hermes ignores return values)
//   on_session_end       observer (Hermes ignores return values)
//
// Wire protocol mirrors Claude Code: the command receives the event as JSON
// on stdin ({hook_event_name, tool_name, tool_input, session_id, cwd, extra})
// and answers on stdout — exit 2 blocks (pre_tool_call only), parsed JSON
// {decision: block, reason} or hookSpecificOutput.permissionDecision: "deny"
// blocks, updatedToolOutput replaces the result (transform_tool_result only).
// tool_input can arrive DOUBLE-ENCODED (a JSON string containing JSON) — the
// bridge decodes defensively so guard hooks never inspect a stringified
// envelope.
//
// Placeholders: __PLUGIN_NAME__, __EVENTS__ (JSON array of TranslatedHook).
const PYTHON_HOOKS_BRIDGE = [
  '',
  '',
  '# --- Hooks bridge (translated from the Claude-format hooks component) ---',
  '',
  'import json',
  'import re as _re',
  'import subprocess as _subprocess',
  'import sys as _sys',
  '',
  '_HOOK_EVENTS = json.loads(',
  '    __EVENTS__',
  ')',
  '',
  '_CLAUDE_EVENT_NAMES = {',
  '    "pre_tool_call": "PreToolUse",',
  '    "post_tool_call": "PostToolUse",',
  '    "transform_tool_result": "PostToolUse",',
  '    "on_session_start": "SessionStart",',
  '    "on_session_end": "SessionEnd",',
  '}',
  '',
  '_TOOL_EVENTS = ("pre_tool_call", "post_tool_call", "transform_tool_result")',
  '',
  '',
  'def _decode_tool_input(raw):',
  '    """Undo double-encoded JSON envelopes: Claude tool-call input can arrive',
  '    as a JSON string containing JSON. Try the inner parse; on failure keep',
  '    the original value so a plain string is never mangled."""',
  '    if not isinstance(raw, str):',
  '        return raw',
  '    stripped = raw.strip()',
  '    if not (stripped.startswith("{") or stripped.startswith("[")):',
  '        return raw',
  '    try:',
  '        return json.loads(stripped)',
  '    except (ValueError, TypeError):',
  '        return raw',
  '',
  '',
  'def _run_hook_commands(event, spec, **kwargs):',
  '    """Run every matching command for one hook event. Returns a list of',
  '    parsed-stdout dicts/None per command. Never raises: an observer bridge',
  '    must stay best-effort, and the gate bridge converts failures to blocks',
  '    at the caller."""',
  '    tool_name = kwargs.get("tool_name") or ""',
  '    matcher = spec.get("matcher")',
  '    if matcher and event in _TOOL_EVENTS:',
  '        if not _re.search(matcher, tool_name):',
  '            return []',
  '    payload = {',
  '        "hook_event_name": _CLAUDE_EVENT_NAMES.get(event, event),',
  '        "tool_name": tool_name,',
  '        "tool_input": _decode_tool_input(kwargs.get("args")),',
  '        "session_id": kwargs.get("session_id") or "",',
  '        "cwd": os.getcwd() if callable(getattr(os, "getcwd", None)) else "",',
  '        "extra": {k: v for k, v in kwargs.items()',
  '                  if k not in ("tool_name", "args", "session_id")},',
  '    }',
  '    stdin_text = json.dumps(payload)',
  '    timeout = int(spec.get("timeout") or 60)',
  '    outputs = []',
  '    for command in spec["commands"]:',
  '        try:',
  '            proc = _subprocess.run(',
  '                command,',
  '                input=stdin_text,',
  '                shell=True,',
  '                capture_output=True,',
  '                text=True,',
  '                timeout=timeout,',
  '            )',
  '        except Exception as exc:',
  '            print(',
  '                f"__PLUGIN_NAME__ plugin: hook command failed ({exc})",',
  '                file=_sys.stderr,',
  '            )',
  '            outputs.append({"__failed__": True, "__stderr__": str(exc)})',
  '            continue',
  '        parsed = None',
  '        if proc.stdout.strip():',
  '            try:',
  '                parsed = json.loads(proc.stdout)',
  '            except (ValueError, TypeError):',
  '                parsed = None',
  '        outputs.append(',
  '            {"__returncode__": proc.returncode, "__stdout_json__": parsed,',
  '             "__stderr__": proc.stderr, "__stdout__": proc.stdout}',
  '        )',
  '    return outputs',
  '',
  '',
  'def _block_message(out):',
  '    """Claude decision contract -> Hermes block directive, or None to pass.',
  '    Exit 2 blocks even without JSON; a JSON denial uses its reason."""',
  '    if not isinstance(out, dict):',
  '        return None',
  '    if out.get("__returncode__") == 2:',
  '        stderr = (out.get("__stderr__") or "").strip()',
  '        if stderr:',
  '            return stderr',
  '        payload = out.get("__stdout_json__")',
  '        if isinstance(payload, dict):',
  '            reason = payload.get("reason") or payload.get("message")',
  '            if isinstance(reason, str) and reason.strip():',
  '                return reason.strip()',
  '        return "Blocked by __PLUGIN_NAME__ hook (exit 2)."',
  '    payload = out.get("__stdout_json__")',
  '    if not isinstance(payload, dict):',
  '        return None',
  '    hso = payload.get("hookSpecificOutput")',
  '    if isinstance(hso, dict) and hso.get("permissionDecision") == "deny":',
  '        reason = hso.get("permissionDecisionReason") or payload.get("reason")',
  '        if isinstance(reason, str) and reason.strip():',
  '            return reason.strip()',
  '        return "Blocked by __PLUGIN_NAME__ hook."',
  '    decision = payload.get("decision")',
  '    if decision == "block":',
  '        reason = payload.get("reason") or payload.get("message")',
  '        if isinstance(reason, str) and reason.strip():',
  '            return reason.strip()',
  '        return "Blocked by __PLUGIN_NAME__ hook."',
  '    return None',
  '',
  '',
  'def _make_gate_bridge(event, specs):',
  '    """pre_tool_call: fail-closed gate. A raising/timeout hook must block,',
  '    never pass — Hermes enforces the same contract for its own dispatch,',
  '    and _block_message already converts every denial shape."""',
  '',
  '    def _bridge(**kwargs):',
  '        for spec in specs:',
  '            for out in _run_hook_commands(event, spec, **kwargs):',
  '                message = _block_message(out)',
  '                if message is not None:',
  '                    return {"action": "block", "message": message}',
  '        return None',
  '',
  '    return _bridge',
  '',
  '',
  'def _make_observer_bridge(event, specs):',
  '    """post_tool_call / on_session_start / on_session_end: observers.',
  '    Hermes ignores the return values; the bridge exists so hook commands',
  '    still see the event. Fail-open: exceptions are swallowed by Hermes\'',
  '    own dispatch, and the bridge itself never raises."""',
  '',
  '    def _bridge(**kwargs):',
  '        for spec in specs:',
  '            _run_hook_commands(event, spec, **kwargs)',
  '        return None',
  '',
  '    return _bridge',
  '',
  '',
  'def _make_transform_bridge(event, specs):',
  '    """transform_tool_result: replace the result only when a command',
  '    emitted an updatedToolOutput payload; otherwise None (unchanged).',
  '    First replacement wins, matching Hermes\' first-str-wins contract."""',
  '',
  '    def _bridge(**kwargs):',
  '        for spec in specs:',
  '            for out in _run_hook_commands(event, spec, **kwargs):',
  '                if not isinstance(out, dict):',
  '                    continue',
  '                payload = out.get("__stdout_json__")',
  '                if not isinstance(payload, dict):',
  '                    continue',
  '                hso = payload.get("hookSpecificOutput")',
  '                updated = None',
  '                if isinstance(hso, dict):',
  '                    updated = hso.get("updatedToolOutput")',
  '                if updated is None:',
  '                    updated = payload.get("updatedToolOutput")',
  '                if isinstance(updated, str):',
  '                    return updated',
  '        return None',
  '',
  '    return _bridge',
  '',
  '',
  'def _register_hook_bridges(ctx):',
  '    # Group specs by Hermes event name; _HOOK_EVENTS is a list of translated',
  '    # entries (one per Claude hooks.json line), NOT one per event.',
  '    by_event = {}',
  '    for spec in _HOOK_EVENTS:',
  '        by_event.setdefault(spec["event"], []).append(spec)',
  '    for event, specs in by_event.items():',
  '        if event == "pre_tool_call":',
  '            bridge = _make_gate_bridge(event, specs)',
  '        elif event == "transform_tool_result":',
  '            bridge = _make_transform_bridge(event, specs)',
  '        else:',
  '            bridge = _make_observer_bridge(event, specs)',
  '        ctx.register_hook(event, bridge)',
  '',
].join('\n')

// Hooks-bridge registration lines spliced into register() via the
// __HOOKS_REGISTER__ placeholder (kept inside the function body, after
// skill registration; empty when no hooks are active).
function hooksRegisterLines(model: PluginModel): string {
  const { hooks } = translateClaudeHooks(model.hooks)
  if (!hooks.length) return ''
  return [
    '',
    '    # Translated hooks register AFTER skills so a broken bridge can never',
    '    # take skill registration down with it (same ordering rationale as the',
    '    # bootstrap path).',
    '    try:',
    '        _register_hook_bridges(ctx)',
    '    except Exception as e:',
    '        print(',
    '            f"__PLUGIN_NAME__ plugin: hooks bridge unavailable ({e}); "',
    '            "skills registered without hook bridges",',
    '            file=_sys.stderr,',
    '        )',
  ]
    .join('\n')
    .replaceAll('__PLUGIN_NAME__', model.config.name)
}

function hooksBridgeBlock(model: PluginModel): { block: string; names: string[] } {
  const { hooks } = translateClaudeHooks(model.hooks)
  if (!hooks.length) return { block: '', names: [] }
  // JSON embedded as a Python string literal: backslash/quote escaping keeps
  // the payload valid under py_compile regardless of user content (commands
  // can contain any character).
  const eventsJson = JSON.stringify(hooks).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const block = PYTHON_HOOKS_BRIDGE.replaceAll('__PLUGIN_NAME__', model.config.name).replace(
    '__EVENTS__',
    `"${eventsJson}"`,
  )
  return { block, names: hermesHookNames(hooks) }
}

const PYTHON_INIT_TEMPLATE = [
  '# GENERATED by everyharness — edit everyharness.yaml instead',
  'import os',
  'import re',
  'import sys',
  'from pathlib import Path',
  '',
  'BOOTSTRAP_MARKER = \'<plugin-bootstrap plugin="__PLUGIN_NAME__">\'',
  '',
  '',
  'def _skills_dir():',
  '    """Locate the __SKILLS_DIR__/ tree for either supported install layout,',
  '    returning (skills_dir, plugin_root).',
  '',
  '    - git-clone install: `.hermes-plugin/` and `__SKILLS_DIR__/` are',
  '      siblings under the plugin root, so this module resolves',
  '      `../__SKILLS_DIR__` (plugin_root = one level up from this file).',
  '    - flattened install: `__SKILLS_DIR__/` sits next to this module',
  "      (plugin_root = this file's directory).",
  '',
  '    Raises loudly when neither matches -- a bootstrap that silently skips',
  '    is how a broken install masquerades as a working one.',
  '    """',
  '    here = os.path.dirname(os.path.realpath(__file__))',
  '    candidates = (',
  '        (os.path.realpath(os.path.join(here, "..", *"__SKILLS_DIR__".split("/"))), os.path.realpath(os.path.join(here, ".."))),',
  '        (os.path.realpath(os.path.join(here, *"__SKILLS_DIR__".split("/"))), here),',
  '    )',
  '    for skills_dir, plugin_root in candidates:',
  '        if os.path.isdir(skills_dir):',
  '            return skills_dir, plugin_root',
  '    raise RuntimeError(',
  '        "__PLUGIN_NAME__ plugin: cannot find the __SKILLS_DIR__/ tree "',
  '        f"(looked at {[c[0] for c in candidates]})."',
  '    )',
  '',
  '',
  'def _strip_frontmatter(content: str) -> str:',
  '    match = re.match(r"^---\\n[\\s\\S]*?\\n---\\n([\\s\\S]*)$", content)',
  '    return (match.group(1) if match else content).strip()',
  '',
  '',
  'def _build_bootstrap(plugin_root: str) -> str:',
  '    bootstrap_path = os.path.join(plugin_root, *"__BOOTSTRAP_PATH__".split("/"))',
  '    with open(bootstrap_path, encoding="utf-8") as f:',
  '        body = _strip_frontmatter(f.read())',
  '    return (',
  '        f"{BOOTSTRAP_MARKER}\\n"',
  '        "This plugin\'s bootstrap content is included below and is already "',
  '        "loaded for this session. Follow it now.\\n\\n"',
  '        f"{body}\\n"',
  '        "</plugin-bootstrap>"',
  '    )',
  '',
  '',
  'def register(ctx):',
  '    skills_dir, plugin_root = _skills_dir()',
  '',
  "    # Register every skill with Hermes' native loader so skill_view can",
  '    # load it on demand. Skills are registered before the bootstrap is',
  '    # built below so a broken bootstrap can never take skill registration',
  '    # down with it.',
  '    # register_skill requires a pathlib.Path — a str raises AttributeError and',
  '    # hermes silently disables the whole plugin (verified 2026-07-23).',
  '    for name in sorted(os.listdir(skills_dir)):',
  '        skill_md = os.path.join(skills_dir, name, "SKILL.md")',
  '        if os.path.isfile(skill_md):',
  '            ctx.register_skill(name, Path(skill_md))',
  '__HOOKS_REGISTER__',
  '',
  '    # The bootstrap file is a separate, less load-bearing concern than the',
  '    # skills registered above -- a missing or unreadable bootstrap should',
  '    # degrade to "skills work, no session bootstrap" rather than disabling',
  '    # the whole plugin.',
  '    try:',
  '        bootstrap = _build_bootstrap(plugin_root)',
  '    except Exception as e:',
  '        print(',
  '            f"__PLUGIN_NAME__ plugin: bootstrap unavailable ({e}); "',
  '            "skills registered without session bootstrap",',
  '            file=sys.stderr,',
  '        )',
  '        return',
  '',
  '    # pre_llm_call returning {"context": ...} is the documented injection',
  "    # path; the context is appended to the first turn's user message.",
  '    def pre_llm_call(',
  '        session_id=None,',
  '        user_message=None,',
  '        conversation_history=None,',
  '        is_first_turn=None,',
  '        model=None,',
  '        platform=None,',
  '        **kwargs,',
  '    ):',
  '        if is_first_turn:',
  '            return {"context": bootstrap}',
  '        return None',
  '',
  '    ctx.register_hook("pre_llm_call", pre_llm_call)',
  '',
].join('\n')

// bootstrap: none variant -- skill registration only. There is no bootstrap
// content to inject, so BOOTSTRAP_MARKER, _strip_frontmatter,
// _build_bootstrap, and the pre_llm_call hook are omitted entirely rather
// than emitted as dead code.
const PYTHON_INIT_TEMPLATE_NO_BOOTSTRAP = [
  '# GENERATED by everyharness — edit everyharness.yaml instead',
  'import os',
  'from pathlib import Path',
  '',
  '',
  'def _skills_dir():',
  '    """Locate the __SKILLS_DIR__/ tree for either supported install layout,',
  '    returning (skills_dir, plugin_root).',
  '',
  '    - git-clone install: `.hermes-plugin/` and `__SKILLS_DIR__/` are',
  '      siblings under the plugin root, so this module resolves',
  '      `../__SKILLS_DIR__` (plugin_root = one level up from this file).',
  '    - flattened install: `__SKILLS_DIR__/` sits next to this module',
  "      (plugin_root = this file's directory).",
  '',
  '    Raises loudly when neither matches -- a bootstrap that silently skips',
  '    is how a broken install masquerades as a working one.',
  '    """',
  '    here = os.path.dirname(os.path.realpath(__file__))',
  '    candidates = (',
  '        (os.path.realpath(os.path.join(here, "..", *"__SKILLS_DIR__".split("/"))), os.path.realpath(os.path.join(here, ".."))),',
  '        (os.path.realpath(os.path.join(here, *"__SKILLS_DIR__".split("/"))), here),',
  '    )',
  '    for skills_dir, plugin_root in candidates:',
  '        if os.path.isdir(skills_dir):',
  '            return skills_dir, plugin_root',
  '    raise RuntimeError(',
  '        "__PLUGIN_NAME__ plugin: cannot find the __SKILLS_DIR__/ tree "',
  '        f"(looked at {[c[0] for c in candidates]})."',
  '    )',
  '',
  '',
  'def register(ctx):',
  '    skills_dir, _plugin_root = _skills_dir()',
  '',
  "    # Register every skill with Hermes' native loader so skill_view can",
  '    # load it on demand.',
  '    # register_skill requires a pathlib.Path — a str raises AttributeError and',
  '    # hermes silently disables the whole plugin (verified 2026-07-23).',
  '    for name in sorted(os.listdir(skills_dir)):',
  '        skill_md = os.path.join(skills_dir, name, "SKILL.md")',
  '        if os.path.isfile(skill_md):',
  '            ctx.register_skill(name, Path(skill_md))',
  '__HOOKS_REGISTER__',
  '',
].join('\n')

function initPyModule(model: PluginModel): string {
  const bootstrapPath = bootstrapContentPath(model)
  const template = bootstrapPath !== undefined ? PYTHON_INIT_TEMPLATE : PYTHON_INIT_TEMPLATE_NO_BOOTSTRAP
  const { block } = hooksBridgeBlock(model)
  // __HOOKS_REGISTER__ splices the try/except registration INSIDE register()
  // (after skill registration); the bridge block appends at module level
  // after the whole template (helpers after register() are fine in Python).
  // With no hooks, block is '' and the register placeholder expands to
  // nothing, leaving the pre-hooks emission byte-identical.
  return (
    template
      .replaceAll('__PLUGIN_NAME__', model.config.name)
      .replaceAll('__SKILLS_DIR__', model.config.components.skills)
      .replaceAll('__BOOTSTRAP_PATH__', bootstrapPath ?? '')
      .replace('__HOOKS_REGISTER__', hooksRegisterLines(model)) + block
  )
}

// `.hermes-plugin/plugin.yaml` -- hand-assembled (not pure yaml.stringify)
// because the generated-file marker must be a `#` comment and the `yaml`
// package's stringify doesn't emit comments: marker line, then
// stringify(...) of the manifest object.
function pluginYaml(model: PluginModel): string {
  const { config } = model
  const manifest: Record<string, unknown> = {
    name: config.name,
    version: config.version,
    description: config.description,
  }
  if (config.author) manifest.author = config.author.name
  // provides_hooks is DERIVED: pre_llm_call when bootstrap is active, plus
  // every translated hook event — never a hand-maintained list (drift is
  // what validate exists to prevent).
  const hookNames: string[] = []
  if (bootstrapContentPath(model) !== undefined) hookNames.push('pre_llm_call')
  hookNames.push(...hermesHookNames(translateClaudeHooks(model.hooks).hooks))
  if (hookNames.length) manifest.provides_hooks = [...new Set(hookNames)].sort()
  return '# GENERATED by everyharness — edit everyharness.yaml instead\n' + stringify(manifest)
}

function pluginYamlFile(model: PluginModel): GeneratedFile {
  return { path: '.hermes-plugin/plugin.yaml', content: pluginYaml(model) }
}

function initPyFile(model: PluginModel): GeneratedFile {
  return { path: '.hermes-plugin/__init__.py', content: initPyModule(model) }
}

// Ground truth per Design decision 4: `hermes plugins install REPO --enable`,
// with REPO substituted from config.repository when it's a github.com URL
// and a `<your-repo>` placeholder otherwise (never a fabricated listing).
function installDoc(model: PluginModel): string {
  const { config } = model
  const repo = githubOwnerRepo(config.repository) ?? '<your-repo>'

  const emitted = [
    "`.hermes-plugin/plugin.yaml` and `.hermes-plugin/__init__.py`, which register every skill natively and (when bootstrap is configured) inject bootstrap content via `pre_llm_call`",
  ]
  if (config.bootstrap.kind === 'generate') {
    emitted.push(`the generated bootstrap file at \`${GENERATED_BOOTSTRAP_PATH}\``)
  }
  const { hooks: translated } = translateClaudeHooks(model.hooks)
  if (translated.length) {
    emitted.push('a hooks bridge translating Claude-format hook events onto Hermes hooks (`pre_tool_call`, `post_tool_call`, `transform_tool_result`, `on_session_start`, `on_session_end`)')
  }
  const { manifest: mcpManifest, warnings: mcpWarnings } = translateMcpForHermes(model)
  if (mcpManifest) {
    emitted.push('`mcp.json` at the plugin root, translated from the plugin\'s MCP server config (Hermes loads MCP servers through the Agent Plugins v1 portable-package mechanism — there is no `ctx.register` API for MCP)')
  }

  const lines = [
    '## What gets emitted',
    '',
    ...emitted.map((e) => `- ${e}`),
    '',
    '## Installing',
    '',
    '```',
    `hermes plugins install ${repo} --enable`,
    '```',
    '',
    "Hermes registers every skill natively via `register_skill`; when bootstrap is configured, the plugin injects it on the first turn through the `pre_llm_call` hook. Consult Hermes' plugin docs if this command doesn't match your installed version.",
    '',
    '## Caveats',
    '',
    `- Hermes prints \`${config.name} doesn't contain plugin.yaml or __init__.py. It may not be a valid Hermes plugin.\` during install. That warning is expected — everyharness emits those files under \`.hermes-plugin/\`, which Hermes locates after the warning. Confirm the install with \`hermes plugins list --plain --no-bundled\`.`,
    "- `hermes plugins enable` takes the manifest name (`" + config.name + "`), not the checkout directory name — the two differ whenever the directory is named something else.",
    '- Hermes imports `.hermes-plugin/__init__.py` as a Python package on every load, so Python writes `.hermes-plugin/__pycache__/` next to it. Add `__pycache__/` to your `.gitignore`; everyharness never edits user files, so it will not do this for you.',
    '- `ctx.register_skill` requires a `pathlib.Path`, not a `str` — the emitted `__init__.py` already wraps every path in `Path(...)`, but hand edits that drop the wrapper silently disable the whole plugin (the `AttributeError` is swallowed by Hermes\u2019 plugin loader).',
  ]
  if (translated.length) {
    lines.push(
      '',
      '## Hook translation notes',
      '',
      '- Hook commands run with the Claude Code wire protocol: the event JSON arrives on stdin (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, `extra`); decisions return via stdout JSON or exit code 2 (exit 2 blocks only `PreToolUse`).',
      '- `PreToolUse` maps to the fail-closed `pre_tool_call` gate: a JSON `{decision: "block", reason}` or `{hookSpecificOutput: {permissionDecision: "deny", ...}}` (or exit 2) blocks the tool with that reason.',
      '- `PostToolUse` maps to the `post_tool_call` observer, and an `updatedToolOutput` payload in its stdout replaces the tool result via `transform_tool_result`.',
      '- `SessionStart` maps to `on_session_start`, an observer only: Hermes ignores that hook\'s return values, so Claude\'s `additionalContext` cannot be injected through it. Hooks that need to inject context must use the bootstrap path instead.',
      '- `SessionEnd` maps to `on_session_end` (also observer-only; Claude gives it no decision control either).',
      '- Every other Claude hook event (UserPromptSubmit, Stop, Notification, ...) has no Hermes analog and is reported as a generate-time warning, never silently dropped.',
      '- The matcher regex is honored only for tool events (`PreToolUse`/`PostToolUse`), matching both Claude and Hermes semantics.',
    )
  }
  if (mcpManifest) {
    lines.push(
      '',
      '## MCP translation notes',
      '',
      "- Hermes loads MCP servers through the Agent Plugins v1 portable-package mechanism: a root `mcp.json` with exactly `{$schema, mcpServers}`. There is no plugin-API registration for MCP servers.",
      '- Server names are NOT prefixed with the plugin identity — a portable server named `ks-demo` is addressed as `mcp__ks-demo__<tool>`. A name collision with a native `config.yaml` `mcp_servers` entry keeps the NATIVE entry (the plugin server is additive, never overriding; only its declared cost keys carry over when the native entry lacks them).',
      '- `stdio` commands must be a single executable token (bare name or `./`-relative, resolved against the plugin root). `PLUGIN_ROOT` and `PLUGIN_DATA` are reserved env keys (Hermes injects them itself).',
      '- `sse` transport is rejected by Hermes (Agent Plugins v1 §7.2.1 allows only `streamable-http` for remote servers) — everyharness refuses it at generate time with a pointed error.',
      '- `${VAR}` placeholders in env/args/headers values pass through literally and resolve at runtime from the profile\'s environment/secret scope — keep secrets env-injected, never literal in `mcp.json`. A remote server whose url/headers still contain a literal `${VAR}` at load fails closed with a missing-credential error.',
      '- Server declarations (`trust`, `timeout`, `costs`, `spend_limit`, `cost_unit`, and app/`requires`/`liveness`) are declared in everyharness.yaml under `harnesses.hermes.servers.<name>` and emitted into `plugin.json` under `extensions."com.nousresearch.hermes".servers`.',
    )
  }
  // Dual-manifest constraint (verified by hermetic PluginManager probe,
  // 2026-11-04): when the install also carries a root plugin.json (any
  // generate with the agent-plugins-1.0 adapter active), portable
  // discovery wins and the native hooks module never runs. Say so — the
  // alternative is an author wondering why their hooks are silent.
  if (mcpManifest && translated.length) {
    lines.push(
      '',
      '## Dual-manifest note',
      '',
      '```',
      'This install carries both a root plugin.json (Agent Plugins v1) and .hermes-plugin/',
      '(native). Hermes loads the PORTABLE manifest when both exist, so the hooks bridge',
      'in .hermes-plugin/__init__.py does NOT run in this configuration — hooks fire only',
      'when the native manifest is the one Hermes discovers (no root plugin.json). Skills and',
      'MCP servers load through the portable path in both configurations.',
      '```',
    )
  }
  return lines.join('\n')
}

export const hermes: HarnessAdapter = {
  name: 'hermes',
  support: {
    skills: 'full',
    commands: 'none',
    agents: 'none',
    hooks: 'full',
    mcp: 'full',
    bootstrap: 'full',
  },
  installDoc,
  emit(model: PluginModel): EmitResult {
    const warnings: string[] = []
    const files: GeneratedFile[] = [pluginYamlFile(model), initPyFile(model)]
    // hermes' __init__.py reads GENERATED_BOOTSTRAP_PATH at runtime (via
    // bootstrapContentPath above) in bootstrap.generate mode -- it must also
    // emit that file itself so the path it reads actually exists when
    // hermes is the only active in-process adapter.
    if (model.config.bootstrap.kind === 'generate') {
      files.push({ path: GENERATED_BOOTSTRAP_PATH, content: generatedBootstrap(model) })
    }

    // MCP: Hermes consumes servers via the Agent Plugins v1 portable
    // package (root mcp.json), NOT via the plugin API. The translation is
    // shared with the agent-plugins-1.0 adapter and byte-identical, so a
    // generate with both adapters active dedupes the single mcp.json.
    // The same dedupe guarantee is why sse rejection throws here too:
    // both adapters must agree the server set is invalid.
    const { manifest: mcp, warnings: mcpWarnings } = translateMcpForHermes(model)
    warnings.push(...mcpWarnings)
    if (mcp && model.config.components.mcp !== 'mcp.json') {
      files.push({ path: 'mcp.json', content: json(mcp) })
    } else if (mcp && model.config.components.mcp === 'mcp.json') {
      warnings.push(
        'mcp.json is occupied by the source MCP config (components.mcp); hermes mcp output skipped — rename the source to .mcp.json',
      )
    }
    // Server declarations (harnesses.hermes.servers) ride in the root
    // plugin.json's extensions block, emitted by the agent-plugins-1.0
    // adapter. When that adapter is excluded the declarations cannot be
    // delivered through any file Hermes reads — say so instead of
    // silently dropping them.
    const hasDeclarations =
      Object.keys(model.config.harnesses.settings['hermes']?.servers ?? {}).length > 0
    if (hasDeclarations && model.config.harnesses.exclude.includes('agent-plugins-1.0')) {
      warnings.push(
        'harnesses.hermes.servers declarations are emitted into plugin.json by the agent-plugins-1.0 adapter, which is excluded; declarations not delivered',
      )
    }

    if (model.commands.length) warnings.push('commands are not emitted for hermes')
    if (model.agents.length) warnings.push('agents are not emitted for hermes')
    // hooks are translated (PreToolUse/PostToolUse/SessionStart/SessionEnd);
    // any UNMAPPABLE Claude event inside the hooks file becomes its own warning.
    warnings.push(...translateClaudeHooks(model.hooks).warnings)

    return { files, warnings }
  },
}
