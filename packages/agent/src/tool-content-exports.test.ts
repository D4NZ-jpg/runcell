import { describe, expect, it } from 'vitest';
import { isToolContent, toolContent } from './index.js';

describe('tool content public exports', () => {
  it('normalizes and recognizes an image-content envelope', () => {
    const result = toolContent([
      { type: 'text', text: 'Rendered page 1' },
      {
        type: 'image',
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mediaType: 'image/png',
      },
    ]);

    expect(isToolContent(result)).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Rendered page 1' },
      { type: 'image', data: 'iVBORw==', mediaType: 'image/png' },
    ]);
  });
});
