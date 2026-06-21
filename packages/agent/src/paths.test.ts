import { describe, expect, it } from 'vitest';
import { assertSafeWorkspacePath } from './paths.js';
import { InvalidOptionError } from './errors.js';

describe('assertSafeWorkspacePath', () => {
  it('accepts and normalizes relative paths', () => {
    expect(assertSafeWorkspacePath('src/index.ts')).toBe('src/index.ts');
    expect(assertSafeWorkspacePath('./README.md')).toBe('README.md');
    expect(assertSafeWorkspacePath('a//b/./c.txt')).toBe('a/b/c.txt');
  });

  it('rejects empty paths', () => {
    expect(() => assertSafeWorkspacePath('')).toThrow(InvalidOptionError);
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafeWorkspacePath('/etc/passwd')).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects drive letters', () => {
    expect(() => assertSafeWorkspacePath('C:/Windows')).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects backslashes', () => {
    expect(() => assertSafeWorkspacePath('src\\index.ts')).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects parent traversal', () => {
    expect(() => assertSafeWorkspacePath('../secrets')).toThrow(
      InvalidOptionError,
    );
    expect(() => assertSafeWorkspacePath('a/../../b')).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects null bytes', () => {
    expect(() => assertSafeWorkspacePath('a\0b')).toThrow(InvalidOptionError);
  });

  it('rejects paths that resolve to nothing', () => {
    expect(() => assertSafeWorkspacePath('./')).toThrow(InvalidOptionError);
  });
});
