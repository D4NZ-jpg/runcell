import { InvalidOptionError } from './errors.js';
import { assertSafeWorkspacePath } from './paths.js';

/**
 * A UTF-8 text file to seed into the sandbox workspace.
 */
export interface TextFileInput {
  path: string;
  text: string;
}

/**
 * A binary file (PDF, image, archive, …) to seed into the sandbox workspace.
 * `mediaType` is advisory metadata used by helper tools (e.g. PDF extraction
 * or image description) to decide how to handle the file.
 */
export interface BinaryFileInput {
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
}

export type FileInput = TextFileInput | BinaryFileInput;

export type NormalizedFile =
  | { kind: 'text'; path: string; text: string }
  | { kind: 'binary'; path: string; bytes: Uint8Array; mediaType?: string };

function isBinaryFileInput(file: FileInput): file is BinaryFileInput {
  return 'bytes' in file;
}

/**
 * Validate a list of file inputs, normalizing paths and rejecting duplicates.
 *
 * @throws {InvalidOptionError} on unsafe paths, duplicate paths, or malformed
 * entries.
 */
export function normalizeFiles(files: readonly FileInput[]): NormalizedFile[] {
  const seen = new Set<string>();
  const normalized: NormalizedFile[] = [];

  for (const file of files) {
    const path = assertSafeWorkspacePath(file.path);
    if (seen.has(path)) {
      throw new InvalidOptionError(`Duplicate file path: ${path}`);
    }
    seen.add(path);

    if (isBinaryFileInput(file)) {
      if (!(file.bytes instanceof Uint8Array)) {
        throw new InvalidOptionError(
          `Binary file "${path}" must provide bytes as a Uint8Array.`,
        );
      }
      normalized.push(
        file.mediaType === undefined
          ? { kind: 'binary', path, bytes: file.bytes }
          : {
              kind: 'binary',
              path,
              bytes: file.bytes,
              mediaType: file.mediaType,
            },
      );
      continue;
    }

    if (typeof file.text !== 'string') {
      throw new InvalidOptionError(
        `Text file "${path}" must provide text as a string.`,
      );
    }
    normalized.push({ kind: 'text', path, text: file.text });
  }

  return normalized;
}
