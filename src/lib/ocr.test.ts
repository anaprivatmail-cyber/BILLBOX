import { describe, expect, it, vi } from 'vitest'
import { extractFields, sanitizeFields, parsePaymentQR_QR } from '../../netlify/functions/ocr.js'
import { parseEPC } from './epc'

describe('OCR extraction (text heuristics)', () => {
  it('imported image with QR uses deterministic QR mapping', () => {
    const qr = [
      'BCD',
      '001',
      '1',
      'SCT',
      '',
      'OPTIPRINT d.o.o.',
      'SI56192001234567892',
      'EUR12.34',
      'INV',
      'SI99 1234567890',
      'Invoice 2026-001',
    ].join('\n')

    const parsed = parsePaymentQR_QR(qr)
    expect(parsed).not.toBeNull()
    const sanitized = sanitizeFields(qr, parsed as any)

    expect(sanitized.creditor_name).toBe('OPTIPRINT d.o.o.')
    expect(sanitized.iban).toBe('SI56192001234567892')
    expect(sanitized.reference).toBe('SI991234567890')
    expect(sanitized.amount).toBe(12.34)
    expect(sanitized.currency).toBe('EUR')
  })

  it('imported PDF with QR uses deterministic QR mapping', () => {
    const qr = [
      'UPNQR',
      'Prejemnik: Komunalno podjetje d.o.o.',
      'IBAN: SI56 1920 0123 4567 892',
      'Sklic: SI99 1234567890',
      'Namen: Voda januar',
      'EUR 10,55',
      'Rok plačila: 12.03.2026',
    ].join('\n')

    const parsed = parsePaymentQR_QR(qr)
    expect(parsed).not.toBeNull()
    const sanitized = sanitizeFields(qr, parsed as any)

    expect(sanitized.creditor_name).toBe('Komunalno podjetje d.o.o.')
    expect(sanitized.iban).toBe('SI56192001234567892')
    expect(sanitized.reference).toBe('SI991234567890')
    expect(sanitized.amount).toBe(10.55)
    expect(sanitized.currency).toBe('EUR')
    expect(sanitized.due_date).toBe('2026-03-12')
  })

  it('does not confuse IBAN for SI reference, and prefers labeled due date', () => {
    // Known-valid example IBAN (Slovenia, 19 chars)
    const iban = 'SI56192001234567892'
    const rawText = [
      'Račun št: 2026-001',
      'Dobavitelj: Komunalno podjetje d.o.o.',
      'Datum izdaje: 01.01.2026',
      `IBAN: ${iban.slice(0, 4)} ${iban.slice(4, 8)} ${iban.slice(8, 12)} ${iban.slice(12, 16)} ${iban.slice(16)}`,
      'Sklic: SI99 1234567890',
      'Namen: Voda januar',
      'Znesek: EUR 10,55',
      'Rok plačila: 12.03.2026',
      'Prejemnik: Komunalno podjetje d.o.o.',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.iban).toBe(iban)
    expect(sanitized.reference).toBe('SI991234567890')
    expect(sanitized.due_date).toBe('2026-03-12')

    // App rule: supplier == payee
    expect(sanitized.supplier).toBe('Komunalno podjetje d.o.o.')
    expect(sanitized.creditor_name).toBe('Komunalno podjetje d.o.o.')
  })

  it('parses international amount formats and English due date labels', () => {
    const rawText = [
      'Invoice No: INV-1001',
      'Supplier: Acme Corp',
      'Amount due: USD 1,234.56',
      'Due date: 03/12/2026',
      'Payee: Acme Corp',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.currency).toBe('USD')
    expect(sanitized.amount).toBe(1234.56)
    // English + slash => interpret as MM/DD
    expect(sanitized.due_date).toBe('2026-03-12')
    expect(sanitized.supplier).toBe('Acme Corp')
    expect(sanitized.creditor_name).toBe('Acme Corp')
  })

  it('extracts supplier and invoice number even when supplier is unlabeled', () => {
    const rawText = [
      'RAČUN',
      'ELEKTRO TEST d.d.',
      'Ulica 1',
      '1000 Ljubljana',
      'Račun št:',
      '2026-001',
      'Znesek: EUR 10,55',
      'Rok plačila: 12.03.2026',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.supplier).toBe('ELEKTRO TEST d.d.')
    expect(sanitized.creditor_name).toBe('ELEKTRO TEST d.d.')
    expect(sanitized.invoice_number).toBe('2026-001')
  })

  it('GEN-I golden: extracts all required payment fields from full document text', () => {
    const rawText = [
      'GEN-I, d.o.o.',
      'Vojkova cesta 58',
      '1000 Ljubljana',
      '',
      'Račun št.: RMS30596129',
      'Električna energija – december 2025',
      'Rok plačila: 22.01.2026',
      'Za plačilo: 63,26 €',
      'IBAN: SI56 0292 2026 0092 885',
      'Sklic: SI12 1234567890123',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.supplier).toMatch(/GEN-I/i)
    expect(sanitized.creditor_name).toMatch(/GEN-I/i)
    expect(sanitized.invoice_number).toBe('RMS30596129')
    expect(sanitized.amount).toBe(63.26)
    expect(sanitized.currency).toBe('EUR')
    expect(sanitized.due_date).toBe('2026-01-22')
    expect(sanitized.iban).toBe('SI56029220260092885')
    expect(sanitized.reference).toBe('SI121234567890123')
    expect(String(sanitized.reference || '')).not.toBe('')
    expect(String(sanitized.purpose || '')).toMatch(/elektr/i)
    expect(String(sanitized.purpose || '')).toMatch(/december\s+2025/i)
  })

  it('finds fields even when they appear later in the document (multi-page simulated)', () => {
    const rawText = [
      'Some supplier header',
      '--- PAGE 1 ---',
      'Intro / marketing text',
      '',
      '--- PAGE 2 ---',
      'Supplier: ACME POWER d.o.o.',
      'Invoice no: INV-2026-0007',
      'Due date: 01/31/2026',
      'Amount due: EUR 120,00',
      'IBAN: SI56192001234567892',
      'Reference: SI99 5555555555',
      'Električna energija – januar 2026',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.supplier).toBe('ACME POWER d.o.o.')
    expect(sanitized.invoice_number).toBe('INV-2026-0007')
    expect(sanitized.amount).toBe(120)
    expect(sanitized.currency).toBe('EUR')
    // English + slash => interpret as MM/DD
    expect(sanitized.due_date).toBe('2026-01-31')
    expect(sanitized.iban).toBe('SI56192001234567892')
    expect(sanitized.reference).toBe('SI995555555555')
    expect(String(sanitized.purpose || '')).toMatch(/januar\s+2026/i)
  })

  it('OCR-only invoice chooses payable amount and clean issuer', () => {
    const rawText = [
      'Uporabnik: OPTIPRINT d.o.o. | Obrazec: AOT',
      'www.optiprint.si',
      'Račun št: 2026-010',
      'Osnova: 80,00 €',
      'DDV 22%: 17,60 €',
      'Za plačilo: 97,60 €',
      'Rok plačila: 15.02.2026',
      'IBAN: SI56 1920 0123 4567 892',
      'Sklic: SI99 1111111111',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.supplier).toBe('OPTIPRINT d.o.o.')
    expect(sanitized.creditor_name).toBe('OPTIPRINT d.o.o.')
    expect(String(sanitized.supplier || '')).not.toMatch(/obrazec|www|http|@|\.si/i)
    expect(sanitized.amount).toBe(97.6)
    expect(sanitized.currency).toBe('EUR')
    expect(sanitized.due_date).toBe('2026-02-15')
  })
})

describe('Reference model parsing', () => {
  it('splits SI reference into model + number', () => {
    const rawText = [
      'Sklic: SI12 12345678',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference).toBe('SI1212345678')
    expect(sanitized.reference_model).toBe('SI 12')
    expect(sanitized.reference_number).toBe('12345678')
  })

  it('uses explicit model line to build reference', () => {
    const rawText = [
      'Model: 12',
      'Sklic: 1234-56',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference_model).toBe('SI 12')
    expect(sanitized.reference_number).toBe('1234-56')
    expect(sanitized.reference).toBe('SI121234-56')
  })

  it('keeps RF model when specified', () => {
    const rawText = [
      'Model RF 05',
      'Sklic: 7788-99',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference_model).toBe('RF 05')
    expect(sanitized.reference_number).toBe('7788-99')
    expect(sanitized.reference).toBe('RF057788-99')
  })

  it('chooses the closest model to the sklic line', () => {
    const rawText = [
      'Model: 12',
      'Random line',
      'Sklic: 123456',
      'Model: 99',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference_model).toBe('SI 99')
    expect(sanitized.reference_number).toBe('123456')
    expect(sanitized.reference).toBe('SI99123456')
  })

  it('parses model-in-sklic combo sentence', () => {
    const rawText = 'Model 12 in sklic 2636 1234'

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference_model).toBe('SI 12')
    expect(sanitized.reference_number).toBe('26361234')
    expect(sanitized.reference).toBe('SI1226361234')
  })

  it('parses spaced SI model+number references', () => {
    const rawText = 'Sklic: SI 12 1234 5678'

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    expect(sanitized.reference_model).toBe('SI 12')
    expect(sanitized.reference_number).toBe('12345678')
    expect(sanitized.reference).toBe('SI1212345678')
  })
})

describe('Currency inference', () => {
  it('infers EUR from IBAN country when currency is missing', () => {
    const rawText = 'Amount due: 10.00'
    const fields = { amount: 10, iban: 'SI56192001234567892' }
    const sanitized = sanitizeFields(rawText, fields as any)

    expect(sanitized.currency).toBe('EUR')
  })

  it('infers USD from $ symbol', () => {
    const rawText = 'Amount due: $10.00'
    const fields = { amount: 10 }
    const sanitized = sanitizeFields(rawText, fields as any)

    expect(sanitized.currency).toBe('USD')
  })

  it('marks currency UNKNOWN when no hints exist', () => {
    const rawText = 'Amount due: 10.00'
    const fields = { amount: 10, iban: 'NO9386011117947' }
    const sanitized = sanitizeFields(rawText, fields as any)

    expect(sanitized.currency).toBe('UNKNOWN')
  })
})

describe('Final required fields logic (golden)', () => {
  const assertIssuerNotDomain = (issuer: any) => {
    expect(String(issuer || '')).not.toMatch(/(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b|@)/i)
  }

  const assertRequiredEitherFilledOrNeedsReview = (sanitized: any) => {
    const missing = Array.isArray(sanitized?.missingFields) ? sanitized.missingFields : []
    if (missing.length) expect(Boolean(sanitized?.needsReview)).toBe(true)
  }

  it('QR (international EPC): deterministic mapping, no invoice/due fallbacks', () => {
    const qr = [
      'BCD',
      '001',
      '1',
      'SCT',
      '',
      'ACME POWER d.o.o.',
      'SI56192001234567892',
      'EUR12.34',
      'COST',
      'SI99 1234567890 Plačilo elektrika januar 2026',
      '',
    ].join('\n')

    const parsed = parseEPC(qr)
    expect(parsed).not.toBeNull()

    const sanitized = sanitizeFields(qr, parsed as any)
    assertIssuerNotDomain(sanitized.supplier)
    expect(sanitized.supplier).toBe('ACME POWER d.o.o.')
    expect(sanitized.creditor_name).toBe('ACME POWER d.o.o.')

    // QR mapping is deterministic: do not invent invoice number / due date.
    expect(sanitized.invoice_number).toBe(null)
    expect(sanitized.due_date).toBe(null)

    // Reference must not be discarded as IBAN fragment.
    expect(sanitized.reference).toBe('SI991234567890')

    // Purpose may be provided by QR; keep it.
    expect(String(sanitized.purpose || '')).not.toBe('')
    expect(String(sanitized.purpose || '')).toMatch(/Pla\u010dilo|elektrika/i)

    expect(Boolean(sanitized.needsReview)).toBe(true)
    expect(Array.isArray(sanitized.missingFields)).toBe(true)
    expect(sanitized.missingFields).toEqual(expect.arrayContaining(['invoice_number', 'due_date']))
    assertRequiredEitherFilledOrNeedsReview(sanitized)
  })

  it('PDF with embedded text: fills all required fields without needsReview', () => {
    const rawText = [
      'ACME POWER d.o.o.',
      'Ulica 1',
      '1000 Ljubljana',
      'DDV ID: SI12345678',
      'Invoice No: INV-2026-0007',
      'Elektri\u010dna energija \u2013 januar 2026',
      'Due date: 2026-01-31',
      'Amount due: EUR 120,00',
      'IBAN: SI56192001234567892',
      'Reference: SI99 5555555555',
      'Portal: https://hitrost.com',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    assertIssuerNotDomain(sanitized.supplier)
    expect(sanitized.supplier).toBe('ACME POWER d.o.o.')
    expect(sanitized.invoice_number).toBe('INV-2026-0007')
    expect(sanitized.amount).toBe(120)
    expect(sanitized.due_date).toBe('2026-01-31')
    expect(String(sanitized.purpose || '')).not.toBe('')
    expect(sanitized.reference).toBe('SI995555555555')

    expect(Boolean(sanitized.needsReview)).toBe(false)
    expect(Array.isArray(sanitized.missingFields)).toBe(true)
    expect(sanitized.missingFields.length).toBe(0)
  })

  it('Scanned PDF (OCR-like text): defaults due date to today+14 and marks needsReview', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'))
    try {
      const rawText = [
        'ACME POWER d.o.o.',
        'Invoice #',
        'INV-2026-0008',
        'Za pla\u010dilo',
        '120,00 \u20ac',
        'IBAN SI56 1920 0123 4567 892',
        'Sklic: SI99 1111111111',
        // Due date intentionally missing
      ].join('\n')

      const extracted = extractFields(rawText)
      const sanitized = sanitizeFields(rawText, extracted)

      assertIssuerNotDomain(sanitized.supplier)
      expect(sanitized.invoice_number).toBe('INV-2026-0008')
      expect(sanitized.amount).toBe(120)
      expect(sanitized.due_date).toBe('2026-01-15')
      expect(sanitized.reviewReasons).toEqual(expect.arrayContaining(['due_date_defaulted']))
      expect(String(sanitized.purpose || '')).not.toBe('')
      expect(Boolean(sanitized.needsReview)).toBe(true)
      assertRequiredEitherFilledOrNeedsReview(sanitized)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Image invoice: payer extracted from customer block but never used as issuer', () => {
    const rawText = [
      'HITROST.COM',
      'https://hitrost.com',
      'GEN-I, d.o.o.',
      'Vojkova cesta 58',
      '1000 Ljubljana',
      'Kupec: Janez Novak',
      'Ra\u010dun \u0161t.: RMS30596129',
      'Rok pla\u010dila: 22.01.2026',
      'Za pla\u010dilo: 63,26 \u20ac',
      'IBAN: SI56 0292 2026 0092 885',
      'Sklic: SI12 1234567890123',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    assertIssuerNotDomain(sanitized.supplier)
    expect(sanitized.supplier).toMatch(/GEN-I/i)
    expect(String(sanitized.payer_name || '')).toMatch(/Janez\s+Novak/i)
    expect(String(sanitized.payer_name || '')).not.toMatch(/GEN-I/i)
    expect(String(sanitized.purpose || '')).not.toBe('')
    expect(sanitized.reference).toBe('SI121234567890123')
    assertRequiredEitherFilledOrNeedsReview(sanitized)
  })

  it('Missing invoice number: generates DOC-YYYYMMDD-XXX and sets needsReview', () => {
    const rawText = [
      'ACME POWER d.o.o.',
      'Kupec: Janez Novak',
      'Elektri\u010dna energija \u2013 januar 2026',
      'Rok pla\u010dila: 22.01.2026',
      'Za pla\u010dilo: 10,55 \u20ac',
      'IBAN: SI56192001234567892',
      'Sklic: SI99 1234567890',
    ].join('\n')

    const extracted = extractFields(rawText)
    const sanitized = sanitizeFields(rawText, extracted)

    assertIssuerNotDomain(sanitized.supplier)
    expect(String(sanitized.invoice_number || '')).toMatch(/^DOC-20260122-001$/)
    expect(Boolean(sanitized.needsReview)).toBe(true)
    expect(sanitized.reviewReasons).toEqual(expect.arrayContaining(['invoice_number_generated']))
    expect(String(sanitized.purpose || '')).toMatch(/elektr/i)
    expect(String(sanitized.purpose || '')).toMatch(/januar\s+2026/i)
    expect(sanitized.reference).toBe('SI991234567890')
    assertRequiredEitherFilledOrNeedsReview(sanitized)
  })
})
