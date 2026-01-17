import { describe, expect, it } from 'vitest'
import { extractFields, sanitizeFields } from '../../netlify/functions/ocr.js'

describe('OCR extraction (text heuristics)', () => {
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
})
