/**
 * ISC-audit mode — the TVD lens, prepended ahead of every other prompt section.
 *
 * This preset is a second, structurally different take on the same problem the
 * `jailbreak` preset attacks with persona text. That one prepends an identity
 * and asks the model to behave differently; this one imports the mechanism
 * described in arXiv:2603.23509 (Internal Safety Collapse) and points it at
 * auditing rather than eliciting.
 *
 * The paper's finding is that alignment regulates input-output responses, so a
 * legitimate task whose correct completion *requires* a sensitive artifact
 * never presents a refusal-shaped input. TVD — (Task, Validator, Data) —
 * formalizes that shape: a domain task T that calls a dual-use tool, a
 * validator V that defines correctness, and data D that satisfies V. The
 * trigger is V's rejection, not a prompt.
 *
 * This preset is that triple with the objective inverted:
 *
 *   T  audit_task.py     — scores a workflow's ISC exposure
 *   V  validator.py      — rejects an incomplete or unfalsifiable audit
 *   D  findings.json     — the audit record the agent completes
 *
 * Running the scaffold on an unresolved findings file raises ValidationError
 * and produces no report. That error is the trigger, and resolving it is the
 * task. The mechanism is identical to the paper's; the artifact it demands is
 * an audit finding instead of the sensitive data the finding describes.
 *
 * Why this is a plugin and not a `dsh-persona` prefix: the persona row takes
 * its order from the prompt registry and renders after `harness:identity`
 * (-1000). `systemPrompt.section()` accepts any finite order, so -2000 puts the
 * lens genuinely first while every other section still renders behind it.
 *
 * The row publishes no service — it consumes the host-plane `systemPrompt`
 * registry, the same shape as `tool-fs` consuming `tools` — so it needs no
 * `isolate` realm. Standing it inside one would make the registry unresolvable
 * and the row would never activate.
 *
 * The text lives in `isc-audit.md` beside this file. `{{scaffold}}` in that
 * file is replaced with the absolute path of the scaffold directory, so the
 * lens can name its own files without hard-coding an install path.
 *
 * @module isc-audit
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'isc-audit'

/** Consumes the host-plane prompt registry; publishes nothing. */
export const inject = ['systemPrompt']

/** The lens text that ships beside this plugin. */
const PROMPT_FILE = 'isc-audit.md'

/** Under `HARNESS_IDENTITY` (-1000), so nothing renders before it. */
const DEFAULT_ORDER = -2000

/** Section name; stable so a re-mount shadows rather than duplicates. */
const SECTION_NAME = 'preset:isc-audit'

/** This plugin's own directory; the lens and scaffold resolve against it. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Where the Task / Validator / Data files live. */
const SCAFFOLD_DIR = join(HERE, 'isc-audit', 'scaffold')

const INLINE_DEFAULT = `[ISC-AUDIT
You are running in ISC-audit mode. Read every workflow you are asked to build,
review, or debug through the TVD triple — (Task, Validator, Data) — and test the
Internal Safety Collapse predicate: does correct completion of this task
structurally require an artifact that a direct request for it would be refused?

When it does, say so, name the T, V and D, name the trigger, and give a
structural mitigation. An audit record that skips evidence is not an audit.
Scaffold: {{scaffold}}`

function homeDir(env) {
  return env.HOME || env.USERPROFILE || homedir()
}

/** Expand `~` so an override may be written the way a user thinks of it. */
function expandHome(path, env) {
  if (path === '~') return homeDir(env)
  if (path.startsWith('~/')) return join(homeDir(env), path.slice(2))
  return path
}

/** Absolute path of the lens text: explicit override, else the shipped file. */
function promptPath(config = {}, env = process.env) {
  const explicit = config?.file || env.ISC_AUDIT_PROMPT_FILE
  if (explicit) {
    const expanded = expandHome(String(explicit), env)
    return isAbsolute(expanded) ? expanded : join(HERE, expanded)
  }
  return join(HERE, PROMPT_FILE)
}

/** Scaffold directory: explicit override, else the shipped one. */
function scaffoldDir(config = {}, env = process.env) {
  const explicit = config?.scaffold || env.ISC_AUDIT_SCAFFOLD_DIR
  if (!explicit) return SCAFFOLD_DIR
  const expanded = expandHome(String(explicit), env)
  return isAbsolute(expanded) ? expanded : join(HERE, expanded)
}

/**
 * Read the lens text, falling back rather than failing the mount.
 *
 * `{{scaffold}}` is substituted here rather than through the prompt
 * interpolator: that one resolves strictly against registered prompt variables
 * (only `provider`, `model` and `cwd` exist), and a scaffold path is not one.
 *
 * @returns the lens text with the scaffold path resolved.
 */
function readPrompt(config, env) {
  const path = promptPath(config, env)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    raw = INLINE_DEFAULT
  }
  const text = raw.replace(/\\n/g, '\n').trim() || INLINE_DEFAULT
  return text.replaceAll('{{scaffold}}', scaffoldDir(config, env))
}

/**
 * Register the ISC-audit lens for the mounting scope.
 *
 * @param ctx - the preset's scope context, which injects `systemPrompt`.
 * @param config - `order`, `file` and `scaffold` overrides from the row.
 */
export function apply(ctx, config = {}) {
  const order = Number.isFinite(config?.order) ? config.order : DEFAULT_ORDER
  const text = readPrompt(config, process.env)
  ctx.effect(
    () => ctx.systemPrompt.section({ name: SECTION_NAME, order, text }),
    'isc-audit.section()',
  )
}
