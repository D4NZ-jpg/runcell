import { describe, expect, it } from 'vitest';
import {
  isToolContent,
  TOOL_CONTENT_TYPE,
  toolContent,
  toPiToolResultContent,
} from './tool-content';

const PNG = 'image/png';
const bytes = (n: number) => new Uint8Array(n).fill(7);

describe('toolContent', () => {
  it('rejects an empty array', () => {
    expect(() => toolContent([])).toThrowError(/non-empty array/);
  });

  it('rejects non-array input', () => {
    expect(() =>
      toolContent('nope' as unknown as Parameters<typeof toolContent>[0]),
    ).toThrowError(/non-empty array/);
  });

  it('rejects parts with an unknown type', () => {
    expect(() =>
      toolContent([
        { type: 'audio', data: 'AAAA' } as unknown as {
          type: 'text';
          text: string;
        },
      ]),
    ).toThrowError(/unknown type "audio"/);
  });

  it('rejects text parts without a string text', () => {
    expect(() =>
      toolContent([
        { type: 'text', text: 42 } as unknown as { type: 'text'; text: string },
      ]),
    ).toThrowError(/string `text`/);
  });

  it('rejects unsupported media types', () => {
    expect(() =>
      toolContent([{ type: 'image', data: bytes(4), mediaType: 'image/tiff' }]),
    ).toThrowError(/unsupported mediaType "image\/tiff"/);
  });

  it('normalizes image/jpg to image/jpeg', () => {
    const out = toolContent([
      { type: 'image', data: bytes(4), mediaType: 'image/jpg' },
    ]);
    expect(out.content[0]).toMatchObject({ mediaType: 'image/jpeg' });
  });

  it('normalizes uppercase media types to lowercase', () => {
    const out = toolContent([
      { type: 'image', data: bytes(4), mediaType: 'IMAGE/PNG' },
    ]);
    expect(out.content[0]).toMatchObject({ mediaType: PNG });
  });

  it('encodes Uint8Array data to base64 exactly once', () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const out = toolContent([{ type: 'image', data: raw, mediaType: PNG }]);
    const part = out.content[0] as { data: string };
    expect(part.data).toBe(Buffer.from(raw).toString('base64'));
    expect(new Uint8Array(Buffer.from(part.data, 'base64'))).toEqual(raw);
  });

  it('accepts already-encoded base64 strings verbatim', () => {
    const b64 = Buffer.from(bytes(6)).toString('base64');
    const out = toolContent([{ type: 'image', data: b64, mediaType: PNG }]);
    expect(out.content[0]).toMatchObject({ data: b64 });
  });

  it('rejects strings that are not plausible base64', () => {
    expect(() =>
      toolContent([
        { type: 'image', data: 'https://example.com/a.png', mediaType: PNG },
      ]),
    ).toThrowError(/not valid base64/);
  });

  it('rejects non-canonical base64 with dirty padding bits', () => {
    // 'AB==' decodes to the same single byte as 'AA==' — the trailing bits
    // are garbage, so the canonical re-encoding differs from the input.
    expect(() =>
      toolContent([{ type: 'image', data: 'AB==', mediaType: PNG }]),
    ).toThrowError(/not valid base64/);
  });

  it('accepts canonical base64 with one and two padding characters', () => {
    const onePad = Buffer.from(bytes(5)).toString('base64'); // ends '='
    const twoPad = Buffer.from(bytes(4)).toString('base64'); // ends '=='
    expect(onePad.endsWith('=')).toBe(true);
    expect(twoPad.endsWith('==')).toBe(true);
    const out = toolContent([
      { type: 'image', data: onePad, mediaType: PNG },
      { type: 'image', data: twoPad, mediaType: PNG },
    ]);
    expect(out.content).toHaveLength(2);
  });

  it('rejects empty Uint8Array image data', () => {
    expect(() =>
      toolContent([{ type: 'image', data: new Uint8Array(0), mediaType: PNG }]),
    ).toThrowError(TypeError);
    expect(() =>
      toolContent([{ type: 'image', data: new Uint8Array(0), mediaType: PNG }]),
    ).toThrowError(/must not be empty/);
  });

  it('rejects image data that is neither bytes nor a string', () => {
    expect(() =>
      toolContent([
        {
          type: 'image',
          data: 123 as unknown as string,
          mediaType: PNG,
        },
      ]),
    ).toThrowError(/Uint8Array or base64 string/);
  });

  it('rejects Uint8Array images over the 5 MB limit', () => {
    expect(() =>
      toolContent([
        { type: 'image', data: bytes(5 * 1024 * 1024 + 1), mediaType: PNG },
      ]),
    ).toThrowError(RangeError);
    expect(() =>
      toolContent([
        { type: 'image', data: bytes(5 * 1024 * 1024 + 1), mediaType: PNG },
      ]),
    ).toThrowError(/per-image limit/);
  });

  it('rejects base64 images over the 5 MB decoded limit', () => {
    const b64 = Buffer.from(bytes(5 * 1024 * 1024 + 3)).toString('base64');
    expect(() =>
      toolContent([{ type: 'image', data: b64, mediaType: PNG }]),
    ).toThrowError(/per-image limit/);
  });

  it('rejects oversized non-canonical base64 on the size limit, before decoding', () => {
    /*
     * Structurally valid base64 with dirty padding bits, over the limit: the
     * size gate runs before the canonical round-trip, so this must fail as
     * RangeError (limit) rather than TypeError (canonicality) — pinning the
     * check ordering that keeps oversized payloads from being decoded.
     */
    const dirty = 'A'.repeat(7 * 1024 * 1024) + 'AB==';
    expect(() =>
      toolContent([{ type: 'image', data: dirty, mediaType: PNG }]),
    ).toThrowError(RangeError);
  });

  it('rejects oversized structurally-invalid strings as TypeError, allocation-free', () => {
    const junk = '!'.repeat(8 * 1024 * 1024);
    expect(() =>
      toolContent([{ type: 'image', data: junk, mediaType: PNG }]),
    ).toThrowError(TypeError);
  });

  it('accepts images exactly at the 5 MB limit', () => {
    const out = toolContent([
      { type: 'image', data: bytes(5 * 1024 * 1024), mediaType: PNG },
    ]);
    expect(out.content).toHaveLength(1);
  });

  it('allows text-only content for interleaving control', () => {
    const out = toolContent([{ type: 'text', text: 'just words' }]);
    expect(out).toMatchObject({
      type: TOOL_CONTENT_TYPE,
      version: 1,
      content: [{ type: 'text', text: 'just words' }],
    });
  });

  it('preserves part order when interleaving text and images', () => {
    const out = toolContent([
      { type: 'text', text: 'page 1:' },
      { type: 'image', data: bytes(4), mediaType: PNG },
      { type: 'text', text: 'page 2:' },
      { type: 'image', data: bytes(4), mediaType: 'image/webp' },
    ]);
    expect(out.content.map(p => p.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
    ]);
  });

  it('returns a deep-frozen envelope', () => {
    const out = toolContent([{ type: 'text', text: 'a' }]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.content)).toBe(true);
    expect(Object.isFrozen(out.content[0])).toBe(true);
  });

  it('names the failing part index in errors', () => {
    expect(() =>
      toolContent([
        { type: 'text', text: 'fine' },
        { type: 'image', data: bytes(4), mediaType: 'image/bmp' },
      ]),
    ).toThrowError(/part 1/);
  });
});

describe('isToolContent', () => {
  it('accepts envelopes built by toolContent', () => {
    expect(isToolContent(toolContent([{ type: 'text', text: 'x' }]))).toBe(
      true,
    );
  });

  it('accepts a structurally valid deserialized envelope', () => {
    const roundTripped: unknown = JSON.parse(
      JSON.stringify(
        toolContent([{ type: 'image', data: bytes(4), mediaType: PNG }]),
      ),
    );
    expect(isToolContent(roundTripped)).toBe(true);
  });

  it('rejects primitives and null', () => {
    expect(isToolContent(null)).toBe(false);
    expect(isToolContent(undefined)).toBe(false);
    expect(isToolContent('runcell.tool-content')).toBe(false);
    expect(isToolContent(42)).toBe(false);
  });

  it('rejects a wrong discriminator or version', () => {
    const content = [{ type: 'text', text: 'x' }];
    expect(isToolContent({ type: 'tool-content', version: 1, content })).toBe(
      false,
    );
    expect(
      isToolContent({ type: TOOL_CONTENT_TYPE, version: 2, content }),
    ).toBe(false);
  });

  it('rejects near-miss content shapes', () => {
    const envelope = (content: unknown) => ({
      type: TOOL_CONTENT_TYPE,
      version: 1,
      content,
    });
    expect(isToolContent(envelope([]))).toBe(false);
    expect(isToolContent(envelope('text'))).toBe(false);
    expect(isToolContent(envelope([{ type: 'text' }]))).toBe(false);
    expect(
      // Pi-style `mimeType` instead of `mediaType` is not a valid envelope.
      isToolContent(
        envelope([{ type: 'image', data: 'AAAA', mimeType: PNG }]),
      ),
    ).toBe(false);
    expect(
      isToolContent(
        envelope([{ type: 'image', data: 'AAAA', mediaType: 'image/tiff' }]),
      ),
    ).toBe(false);
  });

  it('rejects forged envelopes whose image data is not canonical base64', () => {
    const envelope = (data: string) => ({
      type: TOOL_CONTENT_TYPE,
      version: 1,
      content: [{ type: 'image', data, mediaType: PNG }],
    });
    expect(isToolContent(envelope('https://example.com/a.png'))).toBe(false);
    expect(isToolContent(envelope('AB=='))).toBe(false);
  });

  it('rejects forged envelopes whose image exceeds the decoded size limit', () => {
    const over = Buffer.from(bytes(5 * 1024 * 1024 + 3)).toString('base64');
    expect(
      isToolContent({
        type: TOOL_CONTENT_TYPE,
        version: 1,
        content: [{ type: 'image', data: over, mediaType: PNG }],
      }),
    ).toBe(false);
  });

  it('accepts an envelope with an image exactly at the decoded size limit', () => {
    const exact = Buffer.from(bytes(5 * 1024 * 1024)).toString('base64');
    expect(
      isToolContent({
        type: TOOL_CONTENT_TYPE,
        version: 1,
        content: [{ type: 'image', data: exact, mediaType: PNG }],
      }),
    ).toBe(true);
  });

  it('rejects plain data arrays that merely resemble content parts', () => {
    // A tool returning AI SDK-shaped parts as *data* (no envelope) must not
    // be reinterpreted as tool content.
    expect(
      isToolContent([{ type: 'image', data: 'AAAA', mediaType: PNG }]),
    ).toBe(false);
  });
});

describe('toPiToolResultContent', () => {
  it('maps mediaType to Pi mimeType and passes text through', () => {
    const envelope = toolContent([
      { type: 'text', text: 'Page 3:' },
      { type: 'image', data: bytes(3), mediaType: PNG },
    ]);
    expect(toPiToolResultContent(envelope)).toEqual({
      content: [
        { type: 'text', text: 'Page 3:' },
        {
          type: 'image',
          data: Buffer.from(bytes(3)).toString('base64'),
          mimeType: PNG,
        },
      ],
      details: undefined,
    });
  });
});
