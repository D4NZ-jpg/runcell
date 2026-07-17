import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { createAgent, toolContent, type ToolDefinition } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const colorSchema = z.object({
  color: z.string(),
});

const renderBadgeSchema = z.object({});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function createRedPng(width = 8, height = 8): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, standard compression/filtering.

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    scanlines[rowStart] = 0; // No PNG row filter.
    for (let x = 0; x < width; x += 1) {
      scanlines.set([255, 0, 0, 255], rowStart + 1 + x * 4);
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED_BADGE_PNG = createRedPng();

export async function describeRenderedBadge(): Promise<
  z.infer<typeof colorSchema>
> {
  const renderBadge = {
    description: 'Render a small solid-color badge as a PNG image.',
    schema: renderBadgeSchema,
    execute: () =>
      toolContent([
        { type: 'text', text: 'Rendered badge:' },
        {
          type: 'image',
          data: RED_BADGE_PNG,
          mediaType: 'image/png',
        },
      ]),
  } satisfies ToolDefinition<typeof renderBadgeSchema>;

  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    tools: { renderBadge },
  });

  const result = await agent.run({
    prompt:
      'Call renderBadge, inspect the returned image, and report its dominant color.',
    schema: colorSchema,
  });

  return result.data;
}

runExample(import.meta.url, () => describeRenderedBadge());
