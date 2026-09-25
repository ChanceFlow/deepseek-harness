/**
 * Advanced-mode prompt section — the one sentence the standard composition never
 * carried: several tool calls may share one assistant message.
 *
 * Why this row is the whole preset:
 *
 * - Batch execution is already the agent loop's behavior. `dsh-agent-loop`'s
 *   `executeToolCalls()` schedules every call of one assistant message as a
 *   single step: exclusive calls form ordering barriers, and calls whose tool
 *   declares `isConcurrencySafe` share a bounded rolling pool capped by
 *   `maxParallelToolCalls` (default 10). Nothing here changes that.
 *
 * - The model side was missing. The assembled standard prompt has no sentence
 *   about emitting more than one call per message, so an agent defaults to one
 *   call per turn and pays a model round trip for every independent read.
 *
 * - Order 950 sits between the file-reference slot (900) and the per-tool
 *   guidance block that starts at `TOOL_BASH` (1000), so the rule is read just
 *   before the guidance of the tools it applies to. The text names no
 *   `{{variable}}`, which keeps it independent of the prompt interpolator's
 *   registered-variable set (only `provider`, `model`, and `cwd` exist).
 *
 * - This row publishes no service. It only consumes the host-plane
 *   `systemPrompt` registry — the same shape as `tool-fs` consuming `tools` —
 *   so it needs no `isolate` realm. Standing it inside one would make the
 *   registry unresolvable and the row would never activate.
 *
 * The text itself lives in `multi-toolcall.md` beside this file, so the guidance
 * is a file edit rather than a YAML or JavaScript edit. A missing file is not
 * fatal — the row falls back to `MULTI_TOOLCALL_FILE`, and then to the inline
 * default below, so a damaged install still mounts.
 *
 * @module multi-toolcall
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'multi-toolcall'

/** Consumes the host-plane prompt registry; publishes nothing. */
export const inject = ['systemPrompt']

/** The guidance file that ships beside this plugin. */
const PROMPT_FILE = 'multi-toolcall.md'

/** Between `FILE_REFERENCE` (900) and `TOOL_BASH` (1000). */
const DEFAULT_ORDER = 950

/** Section name; stable, and unique within this preset's scope. */
const SECTION_NAME = 'preset:multi-toolcall'

const INLINE_DEFAULT = `Use one assistant message for several tool calls when you already know you need them: the
harness runs that whole list before your next turn, so independent reads, greps, globs, and
searches cost one round trip instead of one each. Calls that do not conflict may run at the
same time; every other call runs in the order you wrote it. When a later call needs an
earlier call's result, put that call in the next message.`

/** This plugin's own directory; the guidance file resolves against it. */
const HERE = dirname(fileURLToPath(import.meta.url))

function homeDir(env) {
  return env.HOME || env.USERPROFILE || homedir()
}

/** Expand `~` so an override may be written the way a user thinks of it. */
function expandHome(path, env) {
  if (path === '~') return homeDir(env)
  if (path.startsWith('~/')) return join(homeDir(env), path.slice(2))
  return path
}

/** Absolute path of the guidance text: explicit override, else the shipped file. */
function promptPath(config = {}, env = process.env) {
  const explicit = config?.file || env.MULTI_TOOLCALL_FILE
  if (explicit) {
    const expanded = expandHome(String(explicit), env)
    return isAbsolute(expanded) ? expanded : join(HERE, expanded)
  }
  return join(HERE, PROMPT_FILE)
}

/**
 * Read the guidance text, falling back rather than failing the mount.
 *
 * A `\n` written literally in the file is also accepted as a line break, so the
 * text stays editable both as a real multi-line document and as a one-liner.
 *
 * @returns the guidance text, or the inline default when no file is readable.
 */
function readPrompt(config, env) {
  const path = promptPath(config, env)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return INLINE_DEFAULT
  }
  const text = raw.replace(/\\n/g, '\n').trim()
  return text === '' ? INLINE_DEFAULT : text
}

/**
 * Register the multi-toolcall section for the mounting scope.
 *
 * @param ctx - the preset's scope context, which injects `systemPrompt`.
 * @param config - `order` and `file` overrides from the composition row.
 */
export function apply(ctx, config = {}) {
  const order = Number.isFinite(config?.order) ? config.order : DEFAULT_ORDER
  const text = readPrompt(config, process.env)
  ctx.effect(
    () => ctx.systemPrompt.section({ name: SECTION_NAME, order, text }),
    'multi-toolcall.section()',
  )
}
