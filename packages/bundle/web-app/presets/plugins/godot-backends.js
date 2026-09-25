/**
 * Godot MCP backend registry — the one row that knows where Godot lives.
 *
 * This plugin exists so the `godot` agent preset names no MCP host, no remote
 * path, and no transport. It reads a backend MANIFEST (data, not composition)
 * and mounts one `@deepseek-ai/dsh-mcp-client` child per enabled entry, so
 * every backend's tools land in their own namespace and any number of Godot
 * editors can be reachable at once:
 *
 *     backends.win  ->  mcp__godot_win__run_project
 *     backends.lan  ->  mcp__godot_lan__run_project
 *
 * The model picks a backend by picking a tool, so switching between configured
 * backends needs no restart; adding one is a manifest edit plus a host restart
 * (a preset mounts once per process).
 *
 * Design constraints this file is built around:
 *
 * - Rows in a preset composition cannot be generated from a file: a composition
 *   is static YAML read by the loader, and `!!js` config expressions run in
 *   `new Function("ctx", "expr", "with (ctx) { return eval(expr) }")` with no
 *   `fs` and no `require`, so they can read `process.env` but not a manifest.
 *   Fanning one manifest entry out into one plugin row is therefore code, and
 *   code in this harness is a plugin.
 *
 * - A preset-relative row (`./plugin/godot-backends.js`) resolves against the
 *   composition's own directory, and Node then resolves THIS file's imports
 *   from that directory too — upward from `~/.dsh/.agent-presets/godot/`, which
 *   never reaches the harness's own `node_modules`. So `dsh-mcp-client` and the
 *   YAML parser are imported through {@link harnessImport}, which retries from
 *   the running harness entry. Both routes land on the same module instance, so
 *   there is exactly one cordis, not two.
 *
 * - This row publishes no service and injects none, so it needs no `isolate`
 *   realm; it only mounts children that register into the host `tools`
 *   registry. That is the same shape as the `tool-fs` row in this composition.
 *
 * @module godot-backends
 */

import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'godot-backends'

/** Publishes nothing; its children resolve the host `tools` registry themselves. */
export const inject = []

/** Manifest filename inside the harness home; `GODOT_BACKENDS_FILE` overrides. */
const MANIFEST_FILE = 'godot-backends.yml'

/** `@deepseek-ai/dsh-mcp-client`'s own `serverName` contract. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const SERVER_NAME_INVALID = /[^A-Za-z0-9_-]/g
const SERVER_NAME_MAX = 32

/** `${NAME}` references inside manifest strings, expanded from the environment. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** The `enabled` switch is this plugin's; every other key belongs to the client. */
const SHARED_KEYS = ['transport', 'serverName', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']
const STDIO_KEYS = ['command', 'args', 'env', 'cwd']
const HTTP_KEYS = ['url', 'headers']
const RECONNECT_KEYS = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts']
const ALL_KEYS = new Set(['enabled', ...SHARED_KEYS, ...STDIO_KEYS, ...HTTP_KEYS])
const TOP_KEYS = new Set(['defaults', 'backends'])

// ── module resolution ───────────────────────────────────────────────────────

/**
 * Import a specifier the way the harness itself would.
 *
 * A plain import is tried first: it is what works when the preset directory
 * carries a `node_modules` link. The fallback resolves from the running
 * harness entry (`process.argv[1]`, realpath'd, which is the `dsh` bin under
 * either launch layout), so a preset that ships only its own files still
 * reaches the harness's dependencies — and reaches the SAME instances the
 * harness loaded.
 *
 * @param specifier - bare package name to import.
 * @returns the imported module namespace.
 */
async function harnessImport(specifier) {
  try {
    return await import(specifier)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  const failures = []
  for (const anchor of [process.argv[1], process.argv[0]]) {
    if (!anchor) continue
    let real
    try {
      real = realpathSync(anchor)
    } catch {
      continue
    }
    try {
      const require = createRequire(real)
      return await import(pathToFileURL(require.resolve(specifier)).href)
    } catch (error) {
      failures.push(`${real} (${error?.code ?? error?.message ?? error})`)
    }
  }
  throw new Error(
    `cannot resolve "${specifier}": not importable from this file, and none of the harness anchors resolved it`
      + (failures.length ? ` — tried ${failures.join(', ')}` : ''),
  )
}

/** The harness's YAML parser, whichever one this deployment installed. */
async function loadYaml() {
  for (const [specifier, pick] of [['yaml', (m) => m.parse], ['js-yaml', (m) => m.load]]) {
    try {
      const parse = pick(await harnessImport(specifier))
      if (typeof parse === 'function') return parse
    } catch {
      // Fall through to the next parser; JSON is always available.
    }
  }
  return (text) => JSON.parse(text)
}

// ── manifest ────────────────────────────────────────────────────────────────

/** The home directory to expand `~` against, read from the env under test. */
function homeDir(env) {
  return env.HOME || env.USERPROFILE || homedir()
}

/** Expand `~` in a user-supplied path. */
function expandHome(path, env) {
  if (path === '~') return homeDir(env)
  if (path.startsWith('~/')) return join(homeDir(env), path.slice(2))
  return path
}

/**
 * Where the backend manifest lives.
 *
 * Precedence is explicit config (the preset row passes
 * `process.env.GODOT_BACKENDS_FILE`) over `GODOT_BACKENDS_FILE` in the ambient
 * environment over `<DSH_HOME>/godot-backends.yml`. Nothing about a backend
 * lives in the composition; this is only the default address of the data.
 *
 * @param config - the row's config object.
 * @param env - environment to read; defaults to `process.env`.
 * @returns an absolute manifest path.
 */
export function manifestPath(config = {}, env = process.env) {
  const explicit = config?.manifest || env.GODOT_BACKENDS_FILE
  if (explicit) {
    const expanded = expandHome(String(explicit), env)
    return isAbsolute(expanded) ? expanded : resolvePath(expanded)
  }
  const home = env.DSH_HOME || join(homeDir(env), '.dsh')
  return join(expandHome(home, env), MANIFEST_FILE)
}

/** Substitute `${NAME}` from the environment; an unset name is an error, not a literal. */
function expandEnv(value, env, where) {
  if (typeof value === 'string') {
    return value.replace(ENV_REF, (match, key) => {
      if (env[key] === undefined) {
        throw new Error(`${where} references \${${key}}, which is not set in the environment`)
      }
      return String(env[key])
    })
  }
  if (Array.isArray(value)) return value.map((item, index) => expandEnv(item, env, `${where}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnv(item, env, `${where}.${key}`)]),
    )
  }
  return value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value, where, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${where} must be a non-empty string`)
  }
  return value
}

function requireStringMap(value, where) {
  if (!isPlainObject(value)) throw new Error(`${where} must be a mapping of strings`)
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`${where}.${key} must be a string`)
  }
  return value
}

function requirePositiveNumber(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be a positive number`)
  }
  return value
}

/** Turn one manifest key into a `serverName`, deriving a valid one from the key. */
function serverNameFor(key, declared, where) {
  if (declared !== undefined) {
    requireString(declared, `${where}.serverName`)
    if (!SERVER_NAME.test(declared)) {
      throw new Error(`${where}.serverName must match [A-Za-z0-9_-]{1,32}, got "${declared}"`)
    }
    return declared
  }
  // The `godot_` prefix and the `_` substitution keep the derived name inside
  // the pattern for any key, including the empty string.
  return `godot_${String(key).replace(SERVER_NAME_INVALID, '_')}`.slice(0, SERVER_NAME_MAX)
}

/**
 * Validate one backend entry and shape the child config.
 *
 * Only the keys the chosen transport accepts are emitted, because
 * `dsh-mcp-client`'s config is a discriminated union: a stdio child must not
 * carry `url`, and an HTTP child must not carry `command`.
 *
 * @returns the child config, or `null` when the entry is disabled.
 */
function normalizeBackend(key, entry, defaults, env) {
  const where = `backends.${key}`
  if (!isPlainObject(entry)) throw new Error(`${where} must be a mapping`)

  const merged = expandEnv({ ...defaults, ...entry }, env, where)
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    throw new Error(`${where}.enabled must be true or false`)
  }
  if (merged.enabled === false) return null

  const unknown = Object.keys(merged).filter((option) => !ALL_KEYS.has(option))
  if (unknown.length) {
    throw new Error(`${where} has unknown option(s) ${unknown.join(', ')} — accepted: ${[...ALL_KEYS].sort().join(', ')}`)
  }

  const transport = merged.transport ?? 'stdio'
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error(`${where}.transport must be "stdio" or "streamable-http", got ${JSON.stringify(merged.transport)}`)
  }

  const config = {
    serverName: serverNameFor(key, merged.serverName, where),
    transport,
  }
  if (merged.toolCallTimeoutMs !== undefined) {
    config.toolCallTimeoutMs = requirePositiveNumber(merged.toolCallTimeoutMs, `${where}.toolCallTimeoutMs`)
  }
  if (merged.failOnStartupError !== undefined) {
    if (typeof merged.failOnStartupError !== 'boolean') {
      throw new Error(`${where}.failOnStartupError must be true or false`)
    }
    config.failOnStartupError = merged.failOnStartupError
  }
  if (merged.reconnect !== undefined) {
    const reconnect = merged.reconnect
    if (!isPlainObject(reconnect)) throw new Error(`${where}.reconnect must be a mapping`)
    const stray = Object.keys(reconnect).filter((option) => !RECONNECT_KEYS.includes(option))
    if (stray.length) throw new Error(`${where}.reconnect has unknown option(s) ${stray.join(', ')}`)
    config.reconnect = reconnect
  }

  if (transport === 'stdio') {
    config.command = requireString(merged.command, `${where}.command`)
    if (merged.args !== undefined) {
      if (!Array.isArray(merged.args)) throw new Error(`${where}.args must be a list of strings`)
      config.args = merged.args.map((arg, index) => requireString(arg, `${where}.args[${index}]`, { allowEmpty: true }))
    }
    if (merged.env !== undefined) config.env = requireStringMap(merged.env, `${where}.env`)
    if (merged.cwd !== undefined) config.cwd = requireString(merged.cwd, `${where}.cwd`, { allowEmpty: true })
  } else {
    config.url = requireString(merged.url, `${where}.url`)
    if (merged.headers !== undefined) config.headers = requireStringMap(merged.headers, `${where}.headers`)
  }
  return config
}

/**
 * Validate a parsed manifest document and shape every enabled child config.
 *
 * Every problem is collected before throwing so one run of the validator
 * reports every broken entry, not just the first.
 *
 * @param doc - the parsed manifest document.
 * @param env - environment for `${NAME}` expansion; defaults to `process.env`.
 * @returns `{ backends }`, each entry ready to hand to `dsh-mcp-client`.
 */
export function normalizeManifest(doc, env = process.env) {
  if (!isPlainObject(doc)) {
    throw new Error('the manifest root must be a mapping with a `backends:` section')
  }
  const stray = Object.keys(doc).filter((option) => !TOP_KEYS.has(option))
  if (stray.length) {
    throw new Error(`unknown top-level key(s) ${stray.join(', ')} — accepted: ${[...TOP_KEYS].sort().join(', ')}`)
  }
  const defaults = doc.defaults ?? {}
  if (!isPlainObject(defaults)) throw new Error('`defaults` must be a mapping')
  const section = doc.backends ?? {}
  if (!isPlainObject(section)) throw new Error('`backends` must be a mapping of named backends')

  const backends = []
  const problems = []
  for (const [key, entry] of Object.entries(section)) {
    try {
      const config = normalizeBackend(key, entry, defaults, env)
      if (config) backends.push({ key, config })
    } catch (error) {
      problems.push(error.message)
    }
  }
  if (problems.length) {
    throw new Error(`invalid manifest entr${problems.length === 1 ? 'y' : 'ies'}:\n  - ${problems.join('\n  - ')}`)
  }

  const seen = new Map()
  for (const { key, config } of backends) {
    const previous = seen.get(config.serverName)
    if (previous) {
      throw new Error(
        `backends.${previous} and backends.${key} both claim serverName "${config.serverName}" —`
          + ' tool names would collide; give one a distinct serverName',
      )
    }
    seen.set(config.serverName, key)
  }
  return { backends }
}

/** Read and parse the manifest; `undefined` when the file does not exist. */
async function readManifest(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
  const parse = await loadYaml()
  try {
    return parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid YAML or JSON: ${error.message}`)
  }
}

// ── plugin ──────────────────────────────────────────────────────────────────

/**
 * Mount one MCP client per enabled backend.
 *
 * A missing manifest is deliberately NOT fatal: the mode still mounts as an
 * ordinary coding agent with a warning naming the path it expected, rather
 * than failing every session on a file the user has not written yet. A
 * manifest that exists but is malformed IS fatal, so a typo surfaces at mount
 * instead of silently dropping a backend.
 *
 * @param ctx - the row's Cordis context; children unwind with its fiber.
 * @param config - the row's config; `manifest` overrides the default path.
 */
export async function apply(ctx, config = {}) {
  const file = manifestPath(config)
  const doc = await readManifest(file)
  if (doc === undefined) {
    ctx.logger?.warn?.(
      `godot-backends: no backend manifest at ${file} — no Godot MCP tools this session;`
        + ' write one to make backends reachable',
    )
    return
  }

  const { backends } = normalizeManifest(doc)
  if (!backends.length) {
    ctx.logger?.info?.(`godot-backends: ${file} enables no backends`)
    return
  }

  const client = await harnessImport('@deepseek-ai/dsh-mcp-client')
  for (const { key, config: child } of backends) {
    ctx.plugin(client, child)
    ctx.logger?.info?.(
      `godot-backends: backend "${key}" mounted as mcp__${child.serverName}__* (${child.transport})`,
    )
  }
}
