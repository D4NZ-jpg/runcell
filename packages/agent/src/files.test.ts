import { describe, expect, it } from 'vitest';
import { normalizeFiles } from './files.js';
import { InvalidOptionError } from './errors.js';

describe('normalizeFiles', () => {
  it('normalizes text files', () => {
    const result = normalizeFiles([{ path: './a.txt', text: 'hello' }]);
    expect(result).toEqual([{ kind: 'text', path: 'a.txt', text: 'hello' }]);
  });

  it('normalizes binary files and preserves mediaType', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = normalizeFiles([
      { path: 'invoice.pdf', bytes, mediaType: 'application/pdf' },
    ]);
    expect(result).toEqual([
      {
        kind: 'binary',
        path: 'invoice.pdf',
        bytes,
        mediaType: 'application/pdf',
      },
    ]);
  });

  it('omits mediaType when not provided', () => {
    const bytes = new Uint8Array([0]);
    const [file] = normalizeFiles([{ path: 'img.png', bytes }]);
    expect(file).toEqual({ kind: 'binary', path: 'img.png', bytes });
    expect(file && 'mediaType' in file).toBe(false);
  });

  it('rejects duplicate paths', () => {
    expect(() =>
      normalizeFiles([
        { path: 'a.txt', text: '1' },
        { path: './a.txt', text: '2' },
      ]),
    ).toThrow(InvalidOptionError);
  });

  it('rejects unsafe paths', () => {
    expect(() =>
      normalizeFiles([{ path: '../escape.txt', text: 'x' }]),
    ).toThrow(InvalidOptionError);
  });
});
