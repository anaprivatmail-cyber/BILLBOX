// Standalone OCR fixture tests.
// This file is NOT imported by the app/runtime. It is only for local verification.

import assert from 'node:assert/strict'
import { __test } from '../ocr.js'

const {
  sanitizeFieldsAiOnly,
  parseMoneyAmountLoose,
  mapCurrencyLoose,
  tryRepairIbanChecksum,
} = __test

function test(name, fn) {
  try {
    fn()
    process.stdout.write(`ok - ${name}\n`)
  } catch (err) {
    process.stderr.write(`FAIL - ${name}\n`)
    throw err
  }
}

// --- Unit-ish helpers ---

test('parseMoneyAmountLoose handles EU style 1.234,56', () => {
  const n = parseMoneyAmountLoose('1.234,56')
  assert.equal(n, 1234.56)
})

test('mapCurrencyLoose maps symbols and codes', () => {
  assert.equal(mapCurrencyLoose('€', ''), 'EUR')
  assert.equal(mapCurrencyLoose('$', ''), 'USD')
  assert.equal(mapCurrencyLoose('GBP', ''), 'GBP')
})

test('tryRepairIbanChecksum repairs common OCR O→0', () => {
  // Use a known-valid checksum IBAN and corrupt a single character.
  const good = 'DE89370400440532013000'
  const bad = good.replace('0', 'O')
  const repaired = tryRepairIbanChecksum(bad)
  assert.equal(repaired, good)
})

// --- End-to-end-ish sanitize fixtures ---

test('sanitizeFieldsAiOnly: EUR amount string + EU date + IBAN + reference', () => {
  const out = sanitizeFieldsAiOnly({
    supplier: 'Telekom Slovenije d.d.',
    creditor_name: null,
    invoice_number: 'RAČ-2026-000123',
    amount: '1.234,56 €',
    currency: '€',
    due_date: '31.01.2026',
    iban: 'DE89370400440532013000',
    reference: 'SI00 123456789012',
    purpose: '',
    item_name: 'Telekom račun januar 2026',
    payment_details: null,
  })

  assert.equal(out.currency, 'EUR')
  assert.equal(out.amount, 1234.56)
  assert.equal(out.due_date, '2026-01-31')
  assert.ok(out.iban && out.iban.startsWith('DE'))
  assert.ok(out.reference && out.reference.length >= 6)
  assert.ok(out.purpose && out.purpose.length > 0, 'purpose should be filled from item_name fallback')
  assert.equal(Array.isArray(out.missingFields), true)
})

test('sanitizeFieldsAiOnly: USD with $ symbol in amount and currency null', () => {
  const out = sanitizeFieldsAiOnly({
    supplier: 'Example Inc',
    invoice_number: 'INV-1009',
    amount: '$1,299.00',
    currency: null,
    due_date: '2026-02-01',
    iban: null,
    reference: null,
    purpose: 'Payment',
  })
  assert.equal(out.amount, 1299.0)
  // Currency may be mapped from amount string via mapCurrencyLoose second argument.
  assert.equal(out.currency, 'USD')
})

test('sanitizeFieldsAiOnly synthesizes payment_details from bank fields when missing', () => {
  const out = sanitizeFieldsAiOnly({
    supplier: 'ACME LLC',
    invoice_number: 'INV-77',
    amount: '100.00',
    currency: 'USD',
    due_date: '2026-03-15',
    iban: null,
    reference: null,
    bic: 'BOFAUS3N',
    account_number: '123456789',
    routing_number: '021000021',
    sort_code: null,
    payment_details: null,
    purpose: 'Invoice INV-77',
  })

  assert.ok(out.payment_details, 'payment_details should be synthesized')
  assert.match(out.payment_details, /BIC:\s*BOFAUS3N/)
  assert.match(out.payment_details, /Account:\s*123456789/)
  assert.match(out.payment_details, /Routing:\s*021000021/)
})

test('sanitizeFieldsAiOnly rejects IBAN-like invoice_number', () => {
  const out = sanitizeFieldsAiOnly({
    supplier: 'Test',
    invoice_number: 'SI56123456789012345',
    amount: '10,00',
    currency: 'EUR',
    due_date: '2026-01-27',
    purpose: 'X',
  })
  assert.equal(out.invoice_number, null)
})

process.stdout.write('ocr-fixturetest: OK\n')
