export type EPCResult = {
  iban?: string
  creditor_name?: string
  amount?: number
  purpose?: string
  reference?: string
  currency?: string
}

// Minimal EPC/SEPA QR parser. Accepts plain text content of QR.
// Spec (simplified):
// BCD\n001\n1\nSCT\nBIC\nName\nIBAN\nEURamount\nPurpose\nReference\n...
export function parseEPC(text: string): EPCResult | null {
  try {
    const lines = text.split(/\r?\n/).map((l) => l.trim())
    if (lines.length < 7) return null
    if (lines[0] !== 'BCD') return null
    const serviceTag = lines[3]
    if (serviceTag !== 'SCT') return null
    const name = lines[5] || ''
    const iban = (lines[6] || '').replace(/\s+/g, '')
    const amountLine = lines[7] || ''
    let amount: number | undefined
    if (amountLine.startsWith('EUR')) {
      const num = amountLine.slice(3)
      const parsed = Number(num.replace(',', '.'))
      if (!Number.isNaN(parsed)) amount = parsed
    }
    const purpose = lines[8] || ''
    const reference = lines[9] || ''
    const result: EPCResult = {
      iban: iban || undefined,
      creditor_name: name || undefined,
      amount,
      purpose: purpose || undefined,
      reference: reference || undefined,
      currency: amountLine.startsWith('EUR') ? 'EUR' : undefined,
    }
    return result
  } catch {
    return null
  }
}

// Heuristic UPN (Slovenia) QR parser.
// Common payloads contain markers like UPNQR and fields with IBAN (SI..), amount, reference (sklic), purpose (namen), and name.
export function parseUPN(text: string): EPCResult | null {
  try {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const joined = lines.join('\n')
    // Detect presence
    if (!/UPNQR|UPN/i.test(joined) && !/SI\d{2}[A-Z0-9]{15,}/.test(joined)) return null
    // IBAN
    const ibanMatch = joined.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/)
    const iban = ibanMatch ? ibanMatch[0].replace(/\s+/g, '') : undefined
    // Amount: prefer explicit EUR or comma/decimal
    let amount: number | undefined
    let currency: string | undefined
    for (const l of lines) {
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
      if (eurMatch) {
        const val = Number(eurMatch[1].replace(',', '.'))
        if (!Number.isNaN(val)) { amount = val; currency = 'EUR'; break }
      }
      const amtMatch = l.match(/([0-9]+(?:[\.,][0-9]{1,2})?)/)
      if (!amount && amtMatch) {
        const val = Number(amtMatch[1].replace(',', '.'))
        if (!Number.isNaN(val) && val > 0) amount = val
      }
    }
    // Reference (sklic)
    let reference: string | undefined
    for (const l of lines) {
      const m = l.match(/(SI\d{2}[0-9]{4,}|sklic:?\s*([A-Z0-9\-\/]+))/i)
      if (m) { reference = (m[1] || m[2] || '').replace(/\s+/g, ''); if (reference) break }
    }
    // Purpose (namen)
    let purpose: string | undefined
    for (const l of lines) {
      const m = l.match(/namen:?\s*(.+)|purpose:?\s*(.+)/i)
      if (m) { purpose = (m[1] || m[2] || '').trim(); if (purpose) break }
    }
    // Creditor name
    let creditor_name: string | undefined
    for (const l of lines) {
      const m = l.match(/prejemnik|recipient|name:?\s*(.+)/i)
      if (m) { const n = (m[1] || '').trim(); if (n) { creditor_name = n; break } }
    }
    const result: EPCResult = { iban, amount, purpose, reference, creditor_name, currency }
    // At least IBAN or amount must be present to consider valid
    if (result.iban || typeof result.amount === 'number') return result
    return null
  } catch {
    return null
  }
}

// Unified parser: try EPC first, then UPN.
export function parsePaymentQR(text: string): EPCResult | null {
  return parseEPC(text) || parseUPN(text)
}
