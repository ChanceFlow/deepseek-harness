/**
 * Durable pi-ai replay metadata and assistant-history reconstruction.
 *
 * Harness content remains the durable source for text and tool calls. This
 * module stores only the provider-native metadata needed to reconstruct a
 * pi-ai assistant message on a later request.
 *
 * @module dsh-llm-pi-ai/replay
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Message, ModelMessageSource, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { Api, AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai'

/** Per-block half of the pi-ai replay envelope, one entry per content block. */
export type PiAiReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

/** Versioned response-level half of the pi-ai replay envelope. */
export interface PiAiReplayResponse {
  kind: 'pi-ai'
  version: 2
  api: Api
  provider: string
  /** Requested model identity, matching the durable assistant source. */
  model: string
  /** Provider-reported model; replay keeps it informational, never as the message's identity. */
  responseModel?: string
  responseId?: string
  /** Provider-native effort for historical replay; absence is preserved. */
  providerThinkingLevel?: string
  stopReason: AssistantMessage['stopReason']
}

/** The validated halves of one pi-ai replay envelope. */
interface PiAiReplayState {
  response: PiAiReplayResponse
  blocks: PiAiReplayBlock[]
}

/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Project a successful pi-ai response into the minimal durable replay state.
 * The per-block half is index-aligned with the streamed blocks (pi-ai content
 * order), so `BlockAssembler` prunes an entry with its block whenever assembly
 * removes one.
 * @param message - completed native pi-ai assistant response.
 * @param requestedModel - request identity stored in the assistant source; defaults to the native model.
 * @returns the versioned lossless-JSON replay projection.
 */
export function toPiReplayState(message: AssistantMessage, requestedModel = message.model): ReplayEnvelope {
  const responseModel = message.api === 'anthropic-messages' && message.model !== requestedModel
    ? message.model : message.responseModel
  const response: PiAiReplayResponse = {
    kind: 'pi-ai',
    version: 2,
    api: message.api,
    provider: message.provider,
    model: requestedModel,
    ...responseModel === undefined ? {} : { responseModel },
    ...message.responseId === undefined ? {} : { responseId: message.responseId },
    ...message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel },
    stopReason: message.stopReason,
  }
  return {
    response,
    blocks: message.content.map((block): PiAiReplayBlock => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
        }
      }
    }),
  }
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

/** Validate the durable adapter-private envelope before it reaches pi-ai. */
function readReplayState(value: unknown): PiAiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay('expected a replay envelope')
  const envelope = value as Record<string, unknown>
  const rawResponse = envelope['response']
  if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) return invalidReplay('expected a response object')
  const response = rawResponse as Record<string, unknown>
  if (response['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
  if (response['version'] !== 2) return invalidReplay(`unsupported version ${String(response['version'])}`)
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof response[key] !== 'string' || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(response['stopReason']))) {
    return invalidReplay('unknown stopReason')
  }
  if (response['responseModel'] !== undefined && typeof response['responseModel'] !== 'string') return invalidReplay('responseModel must be a string')
  if (response['responseId'] !== undefined && typeof response['responseId'] !== 'string') return invalidReplay('responseId must be a string')
  if (response['providerThinkingLevel'] !== undefined && typeof response['providerThinkingLevel'] !== 'string') return invalidReplay('providerThinkingLevel must be a string')
  const blocks = envelope['blocks']
  if (!Array.isArray(blocks)) return invalidReplay('blocks must be an array')
  for (const [index, value] of blocks.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call'].includes(String(block['type']))) return invalidReplay(`block ${index} has an unknown type`)
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature'] as const) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') return invalidReplay(`block ${index} ${signature} must be a string`)
    }
    if (block['redacted'] !== undefined && typeof block['redacted'] !== 'boolean') return invalidReplay(`block ${index} redacted must be boolean`)
  }
  return {
    response: response as unknown as PiAiReplayResponse,
    blocks: blocks as PiAiReplayBlock[],
  }
}

/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      }); break
      case 'image':
        throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
      default:
        // plugin-added block types are not representable in pi-ai.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // Deliberately never equals a catalog API: absent replay state is foreign
    // even if source names the same provider/model as this request.
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/**
 * Placeholder signature for the thinking block this adapter synthesizes when a
 * tool-call turn carries no reasoning.
 *
 * Anthropic-compatible thinking mode rejects a request whose assistant
 * tool-call turn omits the thinking block, and pi-ai drops an empty-text
 * thinking block that has no signature. A non-empty placeholder is therefore
 * what keeps the block on the wire; the synthetic block's text stays empty, so
 * nothing model-visible is added.
 */
const SYNTHETIC_THINKING_SIGNATURE = 'dsh-synthetic-thinking'

/**
 * Hold the passback invariant such an endpoint enforces: every tool-call
 * assistant turn reaching the wire must carry a thinking block.
 *
 * The turn either recorded no reasoning block at all — the provider returned
 * none, or it carries thinking in a provider-native field instead — or recorded
 * an empty one without a signature; pi-ai drops both.
 * @param content - reconstructed pi-ai assistant content, mutated in place.
 */
function holdThinkingOnToolCalls(content: AssistantMessage['content']): void {
  if (!content.some(block => block.type === 'toolCall')) return
  const recorded = content.filter(block => block.type === 'thinking')
  if (recorded.length === 0) {
    content.unshift({ type: 'thinking', thinking: '', thinkingSignature: SYNTHETIC_THINKING_SIGNATURE })
    return
  }
  for (const block of recorded) {
    if (block.thinking.trim().length === 0 && (block.thinkingSignature ?? '').trim().length === 0) {
      block.thinkingSignature = SYNTHETIC_THINKING_SIGNATURE
    }
  }
}

/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(
  message: Message,
  source: ModelMessageSource,
  rawState: unknown,
  holdThinking: boolean,
): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.response.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.response.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
    switch (block.type) {
      case 'text': return {
        type: 'text',
        text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...replay.type === 'tool-call' && replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {},
      }
      /* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added Harness tag cannot reach this switch */
      default: return invalidReplay(`block ${index} has an unsupported Harness type`)
    }
  })
  if (holdThinking) holdThinkingOnToolCalls(content)
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    // The requested id, never the reported alias: pi-ai identifies same-model
    // continuation by `message.model === model.id`, and an endpoint that
    // answers under another name (a gateway alias, or an Anthropic alias or
    // fallback) would otherwise be read as foreign history and lose its
    // thinking block. The reported name stays in `responseModel`.
    model: state.response.model,
    ...state.response.responseModel === undefined ? {} : { responseModel: state.response.responseModel },
    ...state.response.responseId === undefined ? {} : { responseId: state.response.responseId },
    ...state.response.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: state.response.providerThinkingLevel },
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: 0,
  }
}

/**
 * Convert one durable Harness assistant message into pi-ai history.
 *
 * Durable content is the authoritative record; replay metadata only restores
 * native fidelity (ids, signatures). A replay state this build cannot use —
 * another adapter's kind, another version, a malformed value, or metadata that
 * no longer matches the content — therefore degrades the one message to
 * provider-neutral history instead of failing the request.
 * @param message - assistant content with required source and optional adapter-owned replay metadata.
 * @param onDegrade - called with the diagnostic reason when an unusable replay
 *   state falls back to provider-neutral conversion.
 * @param holdThinking - whether the target route requires every tool-call turn
 *   to carry a thinking block; see {@link holdThinkingOnToolCalls}. Provider-neutral
 *   degradation leaves it unapplied: pi-ai drops an empty thinking block from a
 *   foreign message regardless, so synthesizing one there cannot reach the wire.
 * @returns a native pi-ai assistant message reconstructed from durable content.
 */
export function toPiAssistant(
  message: Message,
  onDegrade?: (reason: string) => void,
  holdThinking = false,
): AssistantMessage {
  const source = message.source
  if (source.kind !== 'model' || source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState, holdThinking)
  } catch (error: unknown) {
    /* v8 ignore next -- replayedAssistant throws only INVALID_REPLAY_STATE LlmErrors; the
       guard keeps a future non-replay failure loud instead of silently degrading it */
    if (!(error instanceof LlmError) || error.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}
