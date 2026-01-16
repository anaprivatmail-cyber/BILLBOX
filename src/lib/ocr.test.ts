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
})
