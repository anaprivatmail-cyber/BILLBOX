export type EPCResult = {
  iban?: string
  creditor_name?: string
  amount?: number
  purpose?: string
  reference?: string
  currency?: string
  due_date?: string
}

function normalizeIban(input: string | undefined): string | undefined {
  const s = String(input || '').toUpperCase().replace(/\s+/g, '')
  return s || undefined
}

function normalizeReference(input: string | undefined): string | undefined {
  const s = String(input || '').toUpperCase().replace(/\s+/g, '')
  return s || undefined
}

function looksLikeIban(s: string) {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(s)
}

function isValidIbanChecksum(ibanRaw: string): boolean {
  const s = normalizeIban(ibanRaw)
  if (!s) return false
  if (!looksLikeIban(s)) return false
  const rearranged = s.slice(4) + s.slice(0, 4)
  let remainder = 0
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i]
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97
    } else {
      const val = code - 55 // A->10..Z->35
      remainder = (remainder * 100 + val) % 97
    }
  }
  return remainder === 1
}

function parseIsoDateFromText(s: string): string | undefined {
  const t = String(s || '').trim()
  // YYYY-MM-DD
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]
  // DD.MM.YYYY or DD/MM/YYYY
  const dmY = t.match(/\b(\d{2})[.\/](\d{2})[.\/](\d{4})\b/)
  if (dmY) return `${dmY[3]}-${dmY[2]}-${dmY[1]}`
  return undefined
}

function normalizeQrText(input: string): string {
  const s = (input ?? '').toString()
  let out = s.replace(/\u001d/g, '\n').replace(/\r/g, '\n')
  if (!out.includes('\n') && out.includes('|') && (/\bBCD\b/.test(out) || /UPNQR/i.test(out))) {
    out = out.replace(/\|/g, '\n')
  }
  return out
}

// Minimal EPC/SEPA QR parser. Accepts plain text content of QR.
// Spec (simplified):
// BCD\n001\n1\nSCT\nBIC\nName\nIBAN\nEURamount\nPurpose\nReference\n...
export function parseEPC(text: string): EPCResult | null {
  try {
    const lines = normalizeQrText(text).split(/\n+/).map((l) => l.trim())
    if (lines.length < 7) return null
    if (lines[0] !== 'BCD') return null
    const serviceTag = lines[3]
    if (serviceTag !== 'SCT') return null
    const name = lines[5] || ''
    const ibanRaw = normalizeIban(lines[6] || '')
    const iban = ibanRaw && isValidIbanChecksum(ibanRaw) ? ibanRaw : undefined
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
      reference: normalizeReference(reference) || undefined,
      currency: amountLine.startsWith('EUR') ? 'EUR' : undefined,
    }
    // EPC QR does not normally include a due date; keep undefined.
    return result
  } catch {
    return null
  }
}

// Heuristic UPN (Slovenia) QR parser.
// Common payloads contain markers like UPNQR and fields with IBAN (SI..), amount, reference (sklic), purpose (namen), and name.
export function parseUPN(text: string): EPCResult | null {
  try {
    const normalized = normalizeQrText(text)
    const lines = normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    const joined = lines.join('\n')
    // Detect presence
    if (!/UPNQR|UPN/i.test(joined) && !/SI\d{2}[A-Z0-9]{15,}/.test(joined)) return null
    const findValidIbanInText = (t: string): string | undefined => {
      const matches = String(t || '').match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){11,34}\b/g) || []
      for (const m of matches) {
        const cand = normalizeIban(m)
        if (!cand) continue
        if (isValidIbanChecksum(cand)) return cand
      }
      return undefined
    }
    // IBAN: prefer lines explicitly labeled as IBAN; avoid treating reference (Sklic/Model) as IBAN.
    const iban = (() => {
      for (const l of lines) {
        if (!/\biban\b/i.test(l)) continue
        const v = findValidIbanInText(l)
        if (v) return v
      }
      for (const l of lines) {
        if (/\b(sklic|reference|ref\.?|model)\b/i.test(l)) continue
        const v = findValidIbanInText(l)
        if (v) return v
      }
      return findValidIbanInText(joined)
    })()
    const hasIban = Boolean(iban)
    // Amount: prefer explicit EUR or comma/decimal
    let amount: number | undefined
    let currency: string | undefined
    for (const l of lines) {
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
      if (eurMatch) {
        const val = Number(eurMatch[1].replace(',', '.'))
        if (!Number.isNaN(val)) { amount = val; currency = 'EUR'; break }
      }
      if (!amount && /^\d{11}$/.test(l)) {
        const cents = Number(l)
        const val = cents / 100
        if (Number.isFinite(val) && val > 0) { amount = val; currency = currency || 'EUR'; break }
      }
      const amtMatch = l.match(/([0-9]+(?:[\.,][0-9]{1,2})?)/)
      if (!amount && amtMatch) {
        const val = Number(amtMatch[1].replace(',', '.'))
        if (!Number.isNaN(val) && val > 0) amount = val
      }
    }
    // Reference (sklic) — must not confuse IBAN lines for SIxx references.
    let reference: string | undefined
    for (const l of lines) {
      const labeled = l.match(/\b(sklic|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
      if (!labeled) continue
      const cand = normalizeReference(labeled[2])
      if (!cand) continue
      if (iban && cand === iban) continue
      reference = cand
      if (reference) break
    }
    if (!reference) {
      for (const l of lines) {
        if (/\biban\b/i.test(l)) continue
        const m = l.match(/\bSI\d{2}\s*[0-9A-Z\-\/]{4,}\b/i)
        if (!m) continue
        const cand = normalizeReference(m[0])
        if (!cand) continue
        if (iban && cand === iban) continue
        reference = cand
        if (reference) break
      }
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
      const m = l.match(/\b(prejemnik|recipient|payee|upravi\w*|name)\b\s*:?\s*(.+)/i)
      if (m) {
        const n = String(m[2] || '').trim()
        if (n) { creditor_name = n; break }
      }
    }

    // UPN/Invoices often include an explicit due date (rok / zapade). Only accept if labeled.
    let due_date: string | undefined
    for (const l of lines) {
      if (!/\b(rok|zapade|zapadl|due|pay\s*by|payment\s*due)\b/i.test(l)) continue
      const d = parseIsoDateFromText(l)
      if (d) { due_date = d; break }
    }
    // If not on same line, check the next line after a label-only marker.
    if (!due_date) {
      for (let i = 0; i < lines.length - 1; i++) {
        const l = lines[i]
        if (!/\b(rok|zapade|zapadl|due|pay\s*by|payment\s*due)\b/i.test(l)) continue
        const d = parseIsoDateFromText(lines[i + 1])
        if (d) { due_date = d; break }
      }
    }

    // If creditor name wasn't found via labels, pick a plausible line (after UPNQR) as payee.
    if (!creditor_name) {
      const upnIdx = lines.findIndex((l) => /UPNQR/i.test(l))
      const start = upnIdx >= 0 ? upnIdx + 1 : 0
      for (let i = start; i < Math.min(lines.length, start + 6); i++) {
        const cand = lines[i]
        if (!cand) continue
        if (/^[0-9\s.,:\-\/]+$/.test(cand)) continue
        if (parseIsoDateFromText(cand)) continue
        const c = cand.replace(/\s+/g, '')
        if (looksLikeIban(c)) continue
        if (/\b(EUR|USD|GBP)\b/i.test(cand) || /€/.test(cand)) continue
        if (cand.length < 3 || cand.length > 70) continue
        if (!/[A-Za-zÀ-žČŠŽčšž]/.test(cand)) continue
        creditor_name = cand
        break
      }
    }

    const result: EPCResult = { iban, amount, purpose, reference, creditor_name, currency }
    // At least IBAN or amount must be present to consider valid
    if (due_date) result.due_date = due_date
    if (hasIban || typeof result.amount === 'number') return result
    return null
  } catch {
    return null
  }
}

// Unified parser: try EPC first, then UPN.
export function parsePaymentQR(text: string): EPCResult | null {
  return parseEPC(text) || parseUPN(text)
}
