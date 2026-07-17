import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/*
 * Host tools normally return plain data that gets JSON-stringified into a
 * single text part for the model (see `serializeToolOutput`). Pi itself
 * supports richer tool results — `AgentToolResult.content` is
 * `(TextContent | ImageContent)[]` — but that capability was unreachable from
 * host-registered tools. This module is the explicit opt-in: a tool returns
 * `toolContent([...parts])` and the session builds a real multi-part Pi
 * result (text passed through verbatim, images as actual image blocks)
 * instead of stringifying.
 *
 * The envelope is discriminated by a namespaced string constant rather than a
 * unique symbol because the value crosses serialization boundaries: it is
 * stored in the translator's `hostToolResults` map, and the projected wire
 * `tool-result.result` must be a `JSONValue`. A symbol brand would not
 * survive any of that; a string discriminator plus a structural guard does,
 * while remaining effectively collision-free for real-world tool outputs.
 */

/** Discriminator for the branded tool-content envelope. */
export const TOOL_CONTENT_TYPE = 'runcell.tool-content' as const;

/** Media types accepted for image parts, post-normalization. */
const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type ToolContentImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * Per-image decoded size limit. Matches Anthropic's ~5 MB per-image API
 * limit so oversized images fail loudly at the tool's return site instead of
 * as an opaque provider 400 mid-turn.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A text part; passed to the model verbatim (never stringified). */
export interface ToolContentTextPart {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Image part as accepted by {@link toolContent}. `data` may be raw bytes or
 * an already-encoded base64 string; `mediaType` is case-insensitive and
 * `image/jpg` is normalized to `image/jpeg`.
 */
export interface ToolContentImageInput {
  readonly type: 'image';
  readonly data: Uint8Array | string;
  readonly mediaType: string;
}

/** Union of part shapes accepted by {@link toolContent}. */
export type ToolContentPartInput = ToolContentTextPart | ToolContentImageInput;

/** Image part after normalization: base64 `data`, lowercased media type. */
export interface ToolContentImagePart {
  readonly type: 'image';
  readonly data: string;
  readonly mediaType: ToolContentImageMediaType;
}

/** Normalized part as carried by the envelope and projected on the wire. */
export type ToolContentPart = ToolContentTextPart | ToolContentImagePart;

/**
 * The branded envelope returned by {@link toolContent}. `content` is
 * JSON-safe (base64 image data) so the projection layer can surface it
 * directly as the wire `tool-result.result` after stripping the envelope.
 */
export interface ToolContent {
  readonly type: typeof TOOL_CONTENT_TYPE;
  readonly version: 1;
  readonly content: readonly ToolContentPart[];
}

function isStructuralBase64(value: string): boolean {
  /*
   * Allocation-free shape check — catches "someone passed a URL or raw
   * binary string" without decoding. Callers run this (and the cheap
   * decoded-size limit) before the round-trip in `isCanonicalBase64` so an
   * oversized payload is rejected without ever being decoded or copied.
   */
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function isCanonicalBase64(value: string): boolean {
  /*
   * Structural check plus a canonical round-trip: Node's
   * Buffer.from(..., 'base64') is lenient (it silently accepts dirty
   * padding bits, e.g. 'AB==' decodes to the same byte as 'AA=='), so
   * re-encode the decoded bytes and require an exact match. This is the
   * single validity gate shared by `toolContent()` and `isToolContent()`
   * so a hand-built or deserialized envelope cannot smuggle in data that
   * the constructor would have rejected.
   */
  return (
    isStructuralBase64(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function decodedBase64Size(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function assertWithinImageLimit(decodedBytes: number, index: number): void {
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new RangeError(
      `toolContent: part ${index} image is ${decodedBytes} bytes decoded; ` +
        `the per-image limit is ${MAX_IMAGE_BYTES} bytes (5 MB)`,
    );
  }
}

function normalizeMediaType(raw: string, index: number): ToolContentImageMediaType {
  const lowered = raw.toLowerCase();
  const normalized = lowered === 'image/jpg' ? 'image/jpeg' : lowered;
  const match = IMAGE_MEDIA_TYPES.find(t => t === normalized);
  if (!match) {
    throw new TypeError(
      `toolContent: part ${index} has unsupported mediaType ${JSON.stringify(
        raw,
      )}; supported types are ${IMAGE_MEDIA_TYPES.join(', ')}`,
    );
  }
  return match;
}

function normalizeImagePart(
  part: ToolContentImageInput,
  index: number,
): ToolContentImagePart {
  const mediaType = normalizeMediaType(part.mediaType, index);

  /*
   * Size is enforced before any decode/encode so a runaway payload fails
   * fast on the limit instead of allocating multiples of its input first.
   */
  let data: string;
  if (part.data instanceof Uint8Array) {
    if (part.data.byteLength === 0) {
      throw new TypeError(
        `toolContent: part ${index} image data must not be empty`,
      );
    }
    assertWithinImageLimit(part.data.byteLength, index);
    data = Buffer.from(part.data).toString('base64');
  } else if (typeof part.data === 'string') {
    if (!isStructuralBase64(part.data)) {
      throw new TypeError(
        `toolContent: part ${index} image data string is not valid base64`,
      );
    }
    assertWithinImageLimit(decodedBase64Size(part.data), index);
    if (!isCanonicalBase64(part.data)) {
      throw new TypeError(
        `toolContent: part ${index} image data string is not valid base64`,
      );
    }
    data = part.data;
  } else {
    throw new TypeError(
      `toolContent: part ${index} image data must be a Uint8Array or base64 string`,
    );
  }

  return Object.freeze({ type: 'image', data, mediaType });
}

function normalizePart(part: unknown, index: number): ToolContentPart {
  if (!part || typeof part !== 'object') {
    throw new TypeError(`toolContent: part ${index} is not an object`);
  }
  const type = (part as { type?: unknown }).type;
  if (type === 'text') {
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') {
      throw new TypeError(
        `toolContent: part ${index} text part requires a string \`text\``,
      );
    }
    return Object.freeze({ type: 'text', text });
  }
  if (type === 'image') {
    const mediaType = (part as { mediaType?: unknown }).mediaType;
    if (typeof mediaType !== 'string') {
      throw new TypeError(
        `toolContent: part ${index} image part requires a string \`mediaType\``,
      );
    }
    return normalizeImagePart(
      part as ToolContentImageInput,
      index,
    );
  }
  throw new TypeError(
    `toolContent: part ${index} has unknown type ${JSON.stringify(type)}; ` +
      `expected 'text' or 'image'`,
  );
}

/**
 * Build a multi-part tool result for a host tool. The returned envelope is
 * the explicit opt-in for image-capable results: return it from a tool's
 * `execute()` and the model receives the parts as real content blocks
 * (interleaved text and images) instead of stringified JSON.
 *
 * Validation is eager so mistakes surface at the tool's return site:
 * - `parts` must be a non-empty array of well-formed parts;
 * - image `mediaType` must be one of png/jpeg/gif/webp (`image/jpg` and
 *   uppercase variants are normalized);
 * - image `data` may be raw `Uint8Array` bytes (encoded to base64 here,
 *   once) or an already-encoded base64 string;
 * - each image must be at most 5 MB decoded.
 *
 * Text-only content is allowed — useful purely for interleaving control.
 */
export function toolContent(
  parts: readonly ToolContentPartInput[],
): ToolContent {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError('toolContent: expected a non-empty array of parts');
  }
  const content = Object.freeze(parts.map((p, i) => normalizePart(p, i)));
  return Object.freeze({ type: TOOL_CONTENT_TYPE, version: 1, content });
}

/**
 * Guard for the {@link toolContent} envelope. Used by the session to route
 * host-tool outputs (envelope → multi-part Pi result, anything else → the
 * legacy stringify path) and by the translator to strip the envelope before
 * projecting the wire `tool-result.result`.
 *
 * Beyond the structural shape it re-checks the constructor's data
 * invariants — canonical base64 and the per-image decoded size limit — so a
 * forged or deserialized envelope that never passed through `toolContent()`
 * cannot route unvalidated data to the provider.
 */
export function isToolContent(value: unknown): value is ToolContent {
  if (!value || typeof value !== 'object') return false;
  const v = value as {
    type?: unknown;
    version?: unknown;
    content?: unknown;
  };
  if (v.type !== TOOL_CONTENT_TYPE || v.version !== 1) return false;
  if (!Array.isArray(v.content) || v.content.length === 0) return false;
  return v.content.every(part => {
    if (!part || typeof part !== 'object') return false;
    const p = part as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mediaType?: unknown;
    };
    if (p.type === 'text') return typeof p.text === 'string';
    if (p.type === 'image') {
      return (
        typeof p.data === 'string' &&
        typeof p.mediaType === 'string' &&
        (IMAGE_MEDIA_TYPES as readonly string[]).includes(p.mediaType) &&
        isStructuralBase64(p.data) &&
        decodedBase64Size(p.data) <= MAX_IMAGE_BYTES &&
        isCanonicalBase64(p.data)
      );
    }
    return false;
  });
}

/**
 * Map a normalized envelope to Pi's `AgentToolResult` shape. Pi names the
 * image media type field `mimeType` where our public API (matching the AI
 * SDK convention) uses `mediaType`; this is the single place that renames.
 */
export function toPiToolResultContent(
  envelope: ToolContent,
): AgentToolResult<unknown> {
  return {
    content: envelope.content.map(part =>
      part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : {
            type: 'image' as const,
            data: part.data,
            mimeType: part.mediaType,
          },
    ),
    details: undefined,
  };
}
