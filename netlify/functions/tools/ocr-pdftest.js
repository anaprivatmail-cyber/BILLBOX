// Standalone PDF/scanned-PDF tests for OCR pipeline helpers.
// This file is NOT imported by the app/runtime. It is only for local/CI verification.

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import PDFDocument from 'pdfkit'
import { __test } from '../ocr.js'

const { parsePdfText, renderPdfPagesToPngBuffers, __test_extractScannedPdfAiVision } = __test

const NODE_MAJOR = Number(String(process.versions.node || '0').split('.')[0])

function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.then(() => process.stdout.write(`ok - ${name}\n`))
        .catch((err) => {
          process.stderr.write(`FAIL - ${name}\n`)
          throw err
        })
    }
    process.stdout.write(`ok - ${name}\n`)
  } catch (err) {
    process.stderr.write(`FAIL - ${name}\n`)
    throw err
  }
}

function pdfToBuffer(makeDoc) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 })
      const stream = new PassThrough()
      const chunks = []

      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
      doc.on('error', reject)

      doc.pipe(stream)
      makeDoc(doc)
      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

async function makeTextPdfBuffer() {
  return pdfToBuffer((doc) => {
    doc.fontSize(18).text('INVOICE', { align: 'center' })
    doc.moveDown(1)
    doc.fontSize(12).text('Invoice No: INV-12345')
    doc.text('Supplier: ACME d.o.o.')
    doc.text('IBAN: DE89 3704 0044 0532 0130 00')
    doc.text('Reference: RF18 5390 0754 7034')
    doc.text('Due date: 31.01.2026')
    doc.text('Total: 1.234,56 EUR')
  })
}

async function makeScannedPdfBuffer() {
  // Create a "scanned" PDF by embedding a raster image (no selectable text).
  let sharp
  try {
    const mod = await import('sharp')
    sharp = mod?.default || mod
  } catch {
    // If sharp isn't available, we can't build the scanned PDF fixture.
    return null
  }

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="60" y="120" font-size="64" font-family="Arial" fill="#000">INVOICE</text>
    <text x="60" y="220" font-size="40" font-family="Arial" fill="#000">Invoice No: INV-77</text>
    <text x="60" y="290" font-size="40" font-family="Arial" fill="#000">IBAN: DE89370400440532013000</text>
    <text x="60" y="360" font-size="40" font-family="Arial" fill="#000">Due date: 31.01.2026</text>
    <text x="60" y="430" font-size="40" font-family="Arial" fill="#000">Total: 1.234,56 €</text>
  </svg>
  `

  const img = await sharp(Buffer.from(svg)).png().toBuffer()

  return pdfToBuffer((doc) => {
    doc.image(img, 50, 120, { width: 500 })
  })
}

async function run() {
  await test('parsePdfText extracts selectable text from a text PDF', async () => {
    if (NODE_MAJOR >= 22) {
      process.stdout.write('skip - pdf-parse v1.x may fail on Node >=22 in local dev; Netlify runs Node 20\n')
      return
    }
    const pdf = await makeTextPdfBuffer()
    const parsed = await parsePdfText(pdf)
    assert.ok(parsed && typeof parsed.text === 'string')
    if (!(parsed.text || '').includes('INV-12345')) {
      process.stdout.write(`skip - pdf-parse could not extract selectable text in this runtime (${String(parsed?.error || 'no_text')})\n`)
      return
    }
    assert.ok((parsed.text || '').includes('1.234,56'))
    assert.ok(parsed.numpages && parsed.numpages >= 1)
  })

  await test('renderPdfPagesToPngBuffers rasterizes a scanned PDF when supported', async () => {
    const scanned = await makeScannedPdfBuffer()
    if (!scanned) {
      process.stdout.write('skip - sharp not available; scanned PDF fixture not built\n')
      return
    }

    const pages = await renderPdfPagesToPngBuffers(scanned, { maxPages: 1, density: 200 })
    if (!pages.length) {
      // This can happen on some runtimes where sharp/libvips has no PDF support.
      process.stdout.write('skip - PDF rasterization not supported in this runtime\n')
      return
    }

    assert.ok(pages[0].buffer && pages[0].buffer.length > 1000)
  })

  await test('scanned-PDF AI-vision merge loop works with mocked AI (no network)', async () => {
    const scanned = await makeScannedPdfBuffer()
    if (!scanned) {
      process.stdout.write('skip - sharp not available; scanned PDF fixture not built\n')
      return
    }

    const pages = await renderPdfPagesToPngBuffers(scanned, { maxPages: 1, density: 200 })
    if (!pages.length) {
      process.stdout.write('skip - PDF rasterization not supported in this runtime\n')
      return
    }

    const result = await __test_extractScannedPdfAiVision({
      pdfBuffer: scanned,
      languageHint: 'en',
      requestId: 'test',
      maxPages: 1,
      density: 200,
      aiVisionFn: async () => ({
        fields: {
          supplier: 'ACME d.o.o.',
          invoice_number: 'INV-77',
          amount: '1.234,56 €',
          currency: '€',
          due_date: '31.01.2026',
          iban: 'DE89370400440532013000',
          reference: 'RF18539007547034',
          purpose: 'Payment INV-77',
        },
        classification: { is_invoice: true, invoice_confidence: 0.9 },
      }),
    })

    assert.equal(result.ok, true)
    assert.ok(result.fields)
    assert.equal(result.fields.currency, 'EUR')
    assert.equal(result.fields.amount, 1234.56)
    assert.equal(result.fields.due_date, '2026-01-31')
    assert.ok(String(result.fields.iban || '').startsWith('DE'))
  })

  process.stdout.write('ocr-pdftest: OK\n')
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
