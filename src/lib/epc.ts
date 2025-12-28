export type EPCResult = {
  iban?: string
  creditor_name?: string
  amount?: number
  purpose?: string
  reference?: string
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
    }
    return result
  } catch {
    return null
  }
}
