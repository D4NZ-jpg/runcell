import { describe, expect, it } from 'vitest';
import { isToolContent } from '@local/harness-pi-raw';
import { tinyPdf } from './pdf-pages.fixture.js';
import {
  createReadPdfPagesTool,
  isPdfFile,
  loadPdfPageRenderer,
  type PdfPageRenderer,
} from './pdf-pages.js';

async function requireRenderer(): Promise<PdfPageRenderer> {
  const renderer = await loadPdfPageRenderer();
  if (renderer === undefined) {
    throw new Error('optional PDF peers are missing in the dev environment');
  }
  return renderer;
}

describe('isPdfFile', () => {
  it('detects PDFs by media type or extension', () => {
    expect(isPdfFile({ path: 'a.bin', mediaType: 'application/pdf' })).toBe(
      true,
    );
    expect(isPdfFile({ path: 'attachments/Factura.PDF' })).toBe(true);
    expect(isPdfFile({ path: 'a.png', mediaType: 'image/png' })).toBe(false);
  });
});

describe('loadPdfPageRenderer', () => {
  it('renders pages to PNG with the optional peers installed', async () => {
    const renderer = await requireRenderer();

    const { pageCount, rendered } = await renderer.render(tinyPdf(), undefined);
    expect(pageCount).toBe(1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.page).toBe(1);
    // PNG signature.
    expect(rendered[0]?.png[0]).toBe(0x89);
    expect(rendered[0]?.png[1]).toBe(0x50);
  });

  it('rejects out-of-range pages', async () => {
    const renderer = await requireRenderer();
    await expect(renderer.render(tinyPdf(), [2])).rejects.toThrow(
      'does not exist',
    );
  });

  it('caps the pages per call', async () => {
    const renderer = await requireRenderer();
    await expect(
      renderer.render(tinyPdf(), [1, 1, 1, 1, 1, 1, 1, 1, 1]),
    ).rejects.toThrow('at most 8');
  });
});

describe('createReadPdfPagesTool', () => {
  it('returns tool content with a summary and image parts', async () => {
    const renderer = await requireRenderer();
    const tool = createReadPdfPagesTool(
      new Map([['attachments/factura.pdf', tinyPdf()]]),
      renderer,
    );
    expect(tool.description).toContain('attachments/factura.pdf');

    const result = await tool.execute({
      path: 'attachments/factura.pdf',
      pages: [1],
    });
    expect(isToolContent(result)).toBe(true);
    const content = (
      result as { content: readonly { type: string; text?: string }[] }
    ).content;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[0]?.text).toContain('page(s) 1 of 1');
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
  });

  it('reports unknown paths with the available files', async () => {
    const renderer = await requireRenderer();
    const tool = createReadPdfPagesTool(
      new Map([['attachments/factura.pdf', tinyPdf()]]),
      renderer,
    );
    await expect(
      tool.execute({ path: 'nope.pdf' }) as Promise<unknown>,
    ).rejects.toThrow('attachments/factura.pdf');
  });
});
