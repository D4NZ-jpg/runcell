/** A minimal one-page PDF with a text layer, shared by tests. */
export function tinyPdf(text = 'FACTURA 123'): Uint8Array {
  const pdf =
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R' +
    '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    `4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 40 Td (${text}) Tj ET\nendstream endobj\n` +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
    'trailer<</Root 1 0 R>>';
  return Uint8Array.from(Buffer.from(pdf, 'latin1'));
}
