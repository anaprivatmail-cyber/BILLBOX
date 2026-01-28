import assert from 'node:assert/strict'
import { __test } from '../ocr.js'

function run() {
  // Currency symbol mapping
  {
    const out = __test.sanitizeFieldsAiOnly({ amount: '1.234,56 €', currency: '€', supplier: 'ACME', invoice_number: 'INV-1', due_date: '2026-01-31', purpose: 'Test' })
    assert.equal(out.currency, 'EUR')
    assert.equal(out.amount, 1234.56)
  }
  {
    const out = __test.sanitizeFieldsAiOnly({ amount: '$1,234.56', currency: '$', supplier: 'ACME', invoice_number: 'INV-1', due_date: '2026-01-31', purpose: 'Test' })
    assert.equal(out.currency, 'USD')
    assert.equal(out.amount, 1234.56)
  }
  {
    const out = __test.sanitizeFieldsAiOnly({ amount: '£99.90', currency: '£', supplier: 'ACME', invoice_number: 'INV-1', due_date: '2026-01-31', purpose: 'Test' })
    assert.equal(out.currency, 'GBP')
    assert.equal(out.amount, 99.9)
  }

  // Date coercion
  {
    const out = __test.sanitizeFieldsAiOnly({ invoice_date: '31.01.2026', value_date: '01/02/2026', supplier: 'ACME', invoice_number: 'INV-1', amount: 10, currency: 'EUR', due_date: '2026-01-31', purpose: 'Test' })
    assert.equal(out.invoice_date, '2026-01-31')
    // parseDateToken accepts multiple; for 01/02/2026 it should parse to 2026-02-01 or 2026-01-02 depending on heuristic;
    // we only assert it's in ISO form.
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(out.value_date))
  }

  // IBAN checksum repair (common OCR confusion O<->0)
  {
    const good = 'DE89370400440532013000'
    const bad = good.replace('0', 'O')
    const repaired = __test.tryRepairIbanChecksum(bad)
    assert.equal(repaired, good)
  }

  // BIC validation
  {
    const out = __test.sanitizeFieldsAiOnly({ bic: 'DEUTDEFF', supplier: 'ACME', invoice_number: 'INV-1', amount: 10, currency: 'EUR', due_date: '2026-01-31', purpose: 'Test' })
    assert.equal(out.bic, 'DEUTDEFF')
  }

  console.log('ocr-selftest: OK')
}

run()
