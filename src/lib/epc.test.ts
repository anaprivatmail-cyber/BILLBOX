import { describe, expect, it } from 'vitest'
import { parsePaymentQR } from './epc'
import { parsePaymentQR as parsePaymentQRShared } from '../../packages/shared/src/epc'

describe('parsePaymentQR (EPC/UPN)', () => {
  it('parses EPC/SEPA (BCD/SCT) payload', () => {
    const epc = [
      'BCD',
      '001',
      '1',
      'SCT',
      'GIBASI2X',
      'ACME d.o.o.',
      'SI56 1234 5678 9012 345',
      'EUR12.34',
      'INV',
      'SI12 1234-56',
      'Invoice 2026-001',
    ].join('\n')

    const res = parsePaymentQR(epc)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('ACME d.o.o.')
    expect(res?.iban).toBe('SI56123456789012345')
    expect(res?.amount).toBe(12.34)
    expect(res?.currency).toBe('EUR')
    expect(res?.purpose).toBe('INV')
    expect(res?.reference).toBe('SI121234-56')
  })

  it('parses EPC even when encoded as a single line with | separators', () => {
    const epcPipe =
      'BCD|001|1|SCT|GIBASI2X|ACME d.o.o.|SI56 1234 5678 9012 345|EUR12,34|INV|SI12 1234-56|Invoice 2026-001'

    const res = parsePaymentQR(epcPipe)
    expect(res).not.toBeNull()
    expect(res?.iban).toBe('SI56123456789012345')
    expect(res?.amount).toBe(12.34)
    expect(res?.reference).toBe('SI121234-56')
  })

  it('parses UPN with labeled fields and extracts due_date', () => {
    const upn = [
      'UPNQR',
      'Prejemnik: Komunalno podjetje d.o.o.',
      'IBAN: SI56 1111 2222 3333 444',
      'Sklic: SI99 1234567890',
      'Namen: Voda januar',
      'EUR 10,55',
      'Rok plačila: 12.03.2026',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('Komunalno podjetje d.o.o.')
    expect(res?.iban).toBe('SI56111122223333444')
    expect(res?.reference).toBe('SI991234567890')
    expect(res?.purpose).toBe('Voda januar')
    expect(res?.currency).toBe('EUR')
    expect(res?.amount).toBe(10.55)
    expect(res?.due_date).toBe('2026-03-12')
  })

  it('parses UPN when due date is on the next line', () => {
    const upn = [
      'UPNQR',
      'Prejemnik: Komunalno podjetje d.o.o.',
      'IBAN: SI56 1111 2222 3333 444',
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

  it('heuristically extracts payee name near UPN header when unlabeled', () => {
    const upn = [
      'UPNQR',
      'ELEKTRO TEST d.d.',
      'SI56 1111 2222 3333 444',
      'EUR 99.99',
      'Sklic: SI12 1234',
    ].join('\n')

    const res = parsePaymentQR(upn)
    expect(res).not.toBeNull()
    expect(res?.creditor_name).toBe('ELEKTRO TEST d.d.')
  })

  it('shared parser matches web parser outputs', () => {
    const samples = [
      [
        'BCD',
        '001',
        '1',
        'SCT',
        'GIBASI2X',
        'ACME d.o.o.',
        'SI56 1234 5678 9012 345',
        'EUR12.34',
        'INV',
        'SI12 1234-56',
      ].join('\n'),
      [
        'UPNQR',
        'Prejemnik: Komunalno podjetje d.o.o.',
        'IBAN: SI56 1111 2222 3333 444',
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
