import { InvalidOptionError } from './errors.js';

/**
 * Validate and normalize a path destined for the sandbox workspace.
 *
 * Files passed to an agent always live *inside* the sandbox workspace. To keep
 * that boundary safe we only accept relative POSIX paths that stay within the
 * workspace root. Absolute paths, drive letters, parent traversal (`..`),
 * backslashes and null bytes are all rejected.
 *
 * @returns the cleaned, forward-slash relative path (e.g. `src/index.ts`).
 * @throws {InvalidOptionError} when the path escapes or is malformed.
 */
export function assertSafeWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new InvalidOptionError('File path must be a non-empty string.');
  }

  if (rawPath.includes('\0')) {
    throw new InvalidOptionError(`File path contains a null byte: ${rawPath}`);
  }

  if (rawPath.includes('\\')) {
    throw new InvalidOptionError(
      `File path must use forward slashes, not backslashes: ${rawPath}`,
    );
  }

  if (rawPath.startsWith('/')) {
    throw new InvalidOptionError(
      `File path must be relative to the workspace, not absolute: ${rawPath}`,
    );
  }

  if (/^[a-zA-Z]:/.test(rawPath)) {
    throw new InvalidOptionError(
      `File path must not include a drive letter: ${rawPath}`,
    );
  }

  const segments = rawPath.split('/');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new InvalidOptionError(
        `File path must not traverse outside the workspace ("..") : ${rawPath}`,
      );
    }
    cleaned.push(segment);
  }

  if (cleaned.length === 0) {
    throw new InvalidOptionError(
      `File path does not point at a file: ${rawPath}`,
    );
  }

  return cleaned.join('/');
}
