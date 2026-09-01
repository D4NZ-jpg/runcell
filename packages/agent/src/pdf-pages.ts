import { createRequire } from 'node:module';
import path from 'node:path';
import { toolContent } from '@local/harness-pi-raw';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/** Built-in tool name; reserved so user tools cannot collide with it. */
export const READ_PDF_PAGES_TOOL_NAME = 'readPdfPages';

const MAX_PAGES_PER_CALL = 8;
const DEFAULT_PAGES_PER_CALL = 4;
/** Long-edge target in pixels; keeps each PNG far under the image limit. */
const RENDER_TARGET_PIXELS = 1600;

interface PdfJsModule {
  getDocument(options: {
    data: Uint8Array;
    isEvalSupported: boolean;
    standardFontDataUrl: string;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(page: number): Promise<{
        getViewport(options: { scale: number }): {
          width: number;
          height: number;
        };
        render(options: { canvasContext: unknown; viewport: unknown }): {
          promise: Promise<void>;
        };
      }>;
      canvasFactory: {
        create(
          width: number,
          height: number,
        ): {
          canvas: { toBuffer(format: 'image/png'): Buffer };
          context: unknown;
        };
      };
    }>;
    destroy(): Promise<void>;
  };
}

export interface PdfPageRenderer {
  render(
    bytes: Uint8Array,
    pages: readonly number[] | undefined,
  ): Promise<{
    pageCount: number;
    rendered: { page: number; png: Uint8Array }[];
  }>;
}

let rendererPromise: Promise<PdfPageRenderer | undefined> | undefined;

/**
 * Load the optional PDF page renderer. Requires the optional peers
 * `pdfjs-dist` and `@napi-rs/canvas`; resolves to `undefined` when either is
 * not installed. The result is cached for the process.
 */
export function loadPdfPageRenderer(): Promise<PdfPageRenderer | undefined> {
  rendererPromise ??= (async (): Promise<PdfPageRenderer | undefined> => {
    let pdfjs: PdfJsModule;
    let standardFontDataUrl: string;
    try {
      // pdfjs renders through @napi-rs/canvas internally in Node; importing
      // it here is the presence check that keeps failures at load time.
      await import('@napi-rs/canvas');
      pdfjs =
        (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsModule;
      const require = createRequire(import.meta.url);
      standardFontDataUrl =
        path.join(
          path.dirname(require.resolve('pdfjs-dist/package.json')),
          'standard_fonts',
        ) + path.sep;
    } catch {
      return undefined;
    }

    return {
      async render(bytes, pages) {
        const loadingTask = pdfjs.getDocument({
          // pdfjs transfers the buffer; copy so the seeded file stays intact.
          data: Uint8Array.from(bytes),
          isEvalSupported: false,
          standardFontDataUrl,
        });
        try {
          const document = await loadingTask.promise;
          const pageCount = document.numPages;
          const requested =
            pages ??
            Array.from(
              { length: Math.min(pageCount, DEFAULT_PAGES_PER_CALL) },
              (_, index) => index + 1,
            );
          const invalid = requested.find(
            page => !Number.isSafeInteger(page) || page < 1 || page > pageCount,
          );
          if (invalid !== undefined) {
            throw new Error(
              `Page ${invalid} does not exist; the document has ${pageCount} page(s).`,
            );
          }
          if (requested.length > MAX_PAGES_PER_CALL) {
            throw new Error(
              `Request at most ${MAX_PAGES_PER_CALL} pages per call.`,
            );
          }

          const rendered: { page: number; png: Uint8Array }[] = [];
          for (const pageNumber of requested) {
            const page = await document.getPage(pageNumber);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(
              3,
              Math.max(
                1,
                RENDER_TARGET_PIXELS / Math.max(base.width, base.height),
              ),
            );
            const viewport = page.getViewport({ scale });
            const { canvas, context } = document.canvasFactory.create(
              viewport.width,
              viewport.height,
            );
            await page.render({ canvasContext: context, viewport }).promise;
            rendered.push({
              page: pageNumber,
              png: Uint8Array.from(canvas.toBuffer('image/png')),
            });
          }
          return { pageCount, rendered };
        } finally {
          await loadingTask.destroy().catch(() => undefined);
        }
      },
    };
  })();
  return rendererPromise;
}

/** Test hook: reset the cached renderer probe. */
export function resetPdfPageRendererForTests(): void {
  rendererPromise = undefined;
}

/**
 * Build the built-in `readPdfPages` tool over the run's seeded PDF files.
 * Registered by the runtime only when at least one PDF is seeded and the
 * optional renderer is available.
 */
export function createReadPdfPagesTool(
  pdfFiles: ReadonlyMap<string, Uint8Array>,
  renderer: PdfPageRenderer,
): ToolDefinition {
  const available = [...pdfFiles.keys()].join(', ');
  return {
    description:
      'Render pages of a seeded PDF file as images you can view. ' +
      `Available PDF files: ${available}. Give 1-based page numbers ` +
      `(at most ${MAX_PAGES_PER_CALL} per call); without "pages" the first ` +
      `${DEFAULT_PAGES_PER_CALL} pages are rendered.`,
    schema: z.object({
      path: z.string(),
      pages: z.array(z.number()).optional(),
    }),
    async execute(rawInput) {
      // The harness validated the call against the zod schema above.
      const input = rawInput as { path: string; pages?: number[] };
      const bytes = pdfFiles.get(input.path);
      if (bytes === undefined) {
        throw new Error(
          `No seeded PDF at "${input.path}". Available: ${available}.`,
        );
      }
      const { pageCount, rendered } = await renderer.render(bytes, input.pages);
      return toolContent([
        {
          type: 'text',
          text:
            `${input.path}: rendered page(s) ` +
            `${rendered.map(entry => entry.page).join(', ')} of ${pageCount}.`,
        },
        ...rendered.map(entry => ({
          type: 'image' as const,
          data: entry.png,
          mediaType: 'image/png',
        })),
      ]);
    },
  };
}

/** Whether a normalized file looks like a PDF. */
export function isPdfFile(file: { path: string; mediaType?: string }): boolean {
  return (
    file.mediaType?.toLowerCase() === 'application/pdf' ||
    file.path.toLowerCase().endsWith('.pdf')
  );
}
