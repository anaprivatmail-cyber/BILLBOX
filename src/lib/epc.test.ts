import { describe, expect, it } from 'vitest'
import { parsePaymentQR } from './epc'
import { parsePaymentQR as parsePaymentQRShared } from '../../packages/shared/src/epc'

function makeIban(country: string, bban: string): string {
  const cc = country.toUpperCase()
  const bb = String(bban).replace(/\s+/g, '').toUpperCase()
  const prepared = `${bb}${cc}00`
  const toDigits = (s: string) =>
    s
      .split('')
      .map((ch) => {
        const code = ch.charCodeAt(0)
        if (code >= 48 && code <= 57) return ch
        return String(code - 55)
      })
      .join('')

  const digits = toDigits(prepared)
  let remainder = 0
  for (let i = 0; i < digits.length; i++) {
    remainder = (remainder * 10 + Number(digits[i])) % 97
  }
  const check = String(98 - remainder).padStart(2, '0')
  return `${cc}${check}${bb}`
}

function spacedIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim()
}

describe('parsePaymentQR (EPC/UPN)', () => {
  it('parses EPC/SEPA (BCD/SCT) payload', () => {
    const iban = makeIban('SI', '123456789012345')
    const epc = [
      'BCD',
      '001',
      '1',
      'SCT',
      'GIBASI2X',
      'ACME d.o.o.',
      spacedIban(iban),
      'EUR12.34',
      'INV',
      'SI12 1234-56',
      'Invoice 2026-001',
    ].join('\n')

    const res = parsePaymentQR(epc)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('ACME d.o.o.')
    expect(res?.iban).toBe(iban)
    expect(res?.amount).toBe(12.34)
    expect(res?.currency).toBe('EUR')
    expect(res?.purpose).toBe('INV')
    expect(res?.reference).toBe('SI121234-56')
  })

  it('parses EPC even when encoded as a single line with | separators', () => {
    const iban = makeIban('SI', '123456789012345')
    const epcPipe =
      `BCD|001|1|SCT|GIBASI2X|ACME d.o.o.|${spacedIban(iban)}|EUR12,34|INV|SI12 1234-56|Invoice 2026-001`

    const res = parsePaymentQR(epcPipe)
    expect(res).not.toBeNull()
    expect(res?.iban).toBe(iban)
    expect(res?.amount).toBe(12.34)
    expect(res?.reference).toBe('SI121234-56')
  })

  it('parses UPN with labeled fields and extracts due_date', () => {
    const iban = makeIban('SI', '111122223333444')
    const upn = [
      'UPNQR',
      'Prejemnik: Komunalno podjetje d.o.o.',
      `IBAN: ${spacedIban(iban)}`,
      'Sklic: SI99 1234567890',
      'Namen: Voda januar',
      'EUR 10,55',
      'Rok plačila: 12.03.2026',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('Komunalno podjetje d.o.o.')
    expect(res?.iban).toBe(iban)
    expect(res?.reference).toBe('SI991234567890')
    expect(res?.purpose).toBe('Voda januar')
    expect(res?.currency).toBe('EUR')
    expect(res?.amount).toBe(10.55)
    expect(res?.due_date).toBe('2026-03-12')
  })

  it('parses UPN when due date is on the next line', () => {
    const iban = makeIban('SI', '111122223333444')
    const upn = [
      'UPNQR',
      'Prejemnik: Komunalno podjetje d.o.o.',
      `IBAN: ${spacedIban(iban)}`,
      'Sklic: SI99 1234567890',
      'Namen: Voda januar',
      'EUR 10,55',
      'Rok plačila:',
      '12.03.2026',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.due_date).toBe('2026-03-12')
  })

  it('does not treat a valid IBAN as a reference', () => {
    const iban = makeIban('SI', '999900001111222')
    const upn = [
      'UPNQR',
      'Prejemnik: Test d.o.o.',
      // IBAN appears, but the reference line is incorrectly an IBAN (some OCR/exports do this).
      `IBAN: ${spacedIban(iban)}`,
      `Sklic: ${iban}`,
      'Namen: Test',
      'EUR 1,00',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.iban).toBe(iban)
    // Parser should refuse IBAN-as-reference.
    expect(res?.reference).toBeUndefined()
  })

  it('heuristically extracts payee name near UPN header when unlabeled', () => {
    const iban = makeIban('SI', '222233334444555')
    const upn = [
      'UPNQR',
      'ELEKTRO TEST d.d.',
      spacedIban(iban),
      'EUR 99.99',
      'Sklic: SI12 1234',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('ELEKTRO TEST d.d.')
  })

  it('shared parser matches web parser outputs', () => {
    const iban1 = makeIban('SI', '123456789012345')
    const iban2 = makeIban('SI', '111122223333444')
    const samples = [
      [
        'BCD',
        '001',
        '1',
        'SCT',
        'GIBASI2X',
        'ACME d.o.o.',
        spacedIban(iban1),
        'EUR12.34',
        'INV',
        'SI12 1234-56',
      ].join('\n'),
      [
        'UPNQR',
        'Prejemnik: Komunalno podjetje d.o.o.',
        `IBAN: ${spacedIban(iban2)}`,
        'Sklic: SI99 1234567890',
        'Namen: Voda januar',
        'EUR 10,55',
        'Rok plačila: 12.03.2026',
      ].join('\n'),
    ]

    for (const s of samples) {
      expect(parsePaymentQR(s)).toEqual(parsePaymentQRShared(s))
    }
  })
})
