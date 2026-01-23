import { GoogleAuth } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

function resolveModel() {
  const raw = process.env.OPENAI_MODEL
  const model = typeof raw === 'string' ? raw.trim() : ''
  return model || 'gpt-4.1-mini'
}

function isAiOcrEnabled() {
  // Enabled by default when the API key exists.
  // Can be explicitly disabled via ENABLE_OCR_AI=false (or 0).
  const flag = String(process.env.ENABLE_OCR_AI || '').trim().toLowerCase()
  if (flag === 'false' || flag === '0') return false
  // If flag is explicitly true, or unset/other, enable when we have a key.
  return !!OPENAI_API_KEY
}

function looksLikeMisassignedName(input) {
  const s = String(input || '').trim()
  if (!s) return true
  // Obvious non-name markers
  if (/\b(rok|zapad|zapadl|valuta|datum|due|pay\s*by|payment\s*due)\b/i.test(s)) return true
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) return true
  if (/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/.test(s)) return true
  if (/\bEUR\b/i.test(s) || /€/.test(s)) return true
  const compact = s.replace(/\s+/g, '')
  if (/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/.test(compact)) return true // IBAN-like
  if (/SI\d{2}/i.test(compact)) return true // SI reference prefix
  if (/^[Rr]\d{6,}/.test(compact)) return true // reference-like (common OCR artifact)
  // If it's mostly digits/punctuation, it's not a name.
  const digits = (s.match(/\d/g) || []).length
  const letters = (s.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
  if (letters === 0) return true
  if (digits >= 8 && digits > letters) return true
  if (s.length > 70) return true
  return false
}

function safeParseJson(s) {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

function makeRequestId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `ocr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shouldRetryAi(statusOrCode) {
  if (statusOrCode === 'timeout') return true
  if (typeof statusOrCode !== 'number') return false
  if (statusOrCode === 429) return true
  if (statusOrCode >= 500 && statusOrCode <= 599) return true
  return false
}

async function callOpenAiWithRetry({ body, requestId, tag }) {
  const delays = [500, 1500]
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    let controller
    let timeout
    try {
      controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), 20000)
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const data = await resp.json().catch(() => null)
      if (resp.ok) return { ok: true, data }

      const detail = data?.error?.message || data?.error?.type || data?.error?.code || null
      const status = resp.status
      if (shouldRetryAi(status) && attempt < delays.length) {
        const jitter = Math.floor(Math.random() * 200)
        console.warn('[OCR] AI retrying:', { requestId, tag, status, attempt: attempt + 1 })
        await sleepMs(delays[attempt] + jitter)
        continue
      }
      return { ok: false, status, detail }
    } catch (e) {
      if (timeout) clearTimeout(timeout)
      const isTimeout = e?.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))
      const status = isTimeout ? 'timeout' : 'exception'
      const detail = safeDetailFromError(e)
      if (shouldRetryAi(status) && attempt < delays.length) {
        const jitter = Math.floor(Math.random() * 200)
        console.warn('[OCR] AI retrying:', { requestId, tag, status, attempt: attempt + 1 })
        await sleepMs(delays[attempt] + jitter)
        continue
      }
      return { ok: false, status, detail }
    }
  }
  return { ok: false, status: 'exception', detail: 'ai_retry_exhausted' }
}

function normalizeIban(input) {
  return String(input || '').toUpperCase().replace(/\s+/g, '')
}

const IBAN_LENGTHS = {
  // Common SEPA / EU
  AL: 28,
  AD: 24,
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TR: 26,
}

function isValidIbanChecksum(iban) {
  const s = normalizeIban(iban)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(s)) return false
  const cc = s.slice(0, 2)
  const expected = IBAN_LENGTHS[cc]
  if (expected && s.length !== expected) return false
  // Move first 4 chars to end, convert letters to numbers (A=10..Z=35), mod 97 must be 1.
  const rearranged = s.slice(4) + s.slice(0, 4)
  let remainder = 0
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i]
    const code = ch.charCodeAt(0)
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97
    } else {
      const val = code - 55 // 'A' -> 10
      remainder = (remainder * 100 + val) % 97
    }
  }
  return remainder === 1
}

function parseMoneyAmountLoose(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const cleaned = raw.replace(/[^0-9.,\-\s]/g, '').trim()
  if (!/[0-9]/.test(cleaned)) return null
  const s = cleaned.replace(/\s+/g, '')
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  let decimalSep = null
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.'
  else if (lastComma >= 0) decimalSep = ','
  else if (lastDot >= 0) decimalSep = '.'

  let normalized = s
  if (decimalSep === ',') normalized = s.replace(/\./g, '').replace(',', '.')
  else if (decimalSep === '.') normalized = s.replace(/,/g, '')
  normalized = normalized.replace(/(?!^)-/g, '')
  const num = Number(normalized)
  return Number.isFinite(num) ? num : null
}

function extractIbanCandidates(rawText) {
  const upper = String(rawText || '').toUpperCase()
  const found = upper.match(/\b[A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,34}\b/g) || []
  const unique = [...new Set(found.map(normalizeIban).filter(isValidIbanChecksum))]
  const scored = unique
    .map((iban) => ({ iban, score: scoreIbanContext(rawText, iban) }))
    .sort((a, b) => b.score - a.score)
  return scored
}

function extractReferenceCandidates(rawText) {
  const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean).filter(line => line.length > 0)
  // IMPORTANT: Do NOT treat every "SI\d\d..." token as IBAN-like.
  // Slovenian references also start with SI\d\d, and a broad IBAN-like scan would
  // incorrectly reject legitimate references. Only consider:
  // - checksum-valid IBANs
  // - IBAN-like tokens on lines explicitly labeled as IBAN/account/TRR
  const labeledIbanLike = []
  for (const l of lines) {
    if (!/\b(iban|trr|ra\u010dun|racun|account)\b/i.test(l)) continue
    const matches = String(l || '').toUpperCase().match(/\b[A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){8,34}\b/g) || []
    for (const m of matches) {
      const cand = normalizeIban(m)
      if (cand) labeledIbanLike.push(cand)
    }
  }
  const validIbans = extractIbanCandidates(text).map((x) => x.iban)
  const ibanLike = [...new Set([...validIbans, ...labeledIbanLike].filter(Boolean))]
  // Allow spaces inside the token so we can capture whole strings like:
  // "SI56 0292 1503 0596 1290" (IBAN) and then exclude it by checksum.
  const refTokenRe = /\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/gi

  const normalizeRef = (s, mode = 'fallback') => {
    const upper = String(s || '').toUpperCase()
    const m = upper.match(/\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/i)
    const picked = m ? m[1] : upper
    const compact = picked.replace(/\s+/g, '')
    // If it is actually an IBAN (checksum-valid), it must not be considered a payment reference.
    if (isValidIbanChecksum(compact)) return null
    // Also reject any candidate that is a prefix/substring of an IBAN-like token (checksum may fail due to OCR).
    if (compact && /^(SI|RF)\d{2}/i.test(compact)) {
      for (const ib of ibanLike) {
        if (!ib) continue
        if (ib.includes(compact) || ib.startsWith(compact) || compact.startsWith(ib)) return null
      }
    }
    // Keep only plausible references.
    if (/^SI\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return compact
    if (/^RF\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return compact
    return null
  }

  const out = []
  const seen = new Set()

  // Prefer explicitly labeled lines.
  for (const l of lines) {
    const labeled = l.match(/\b(sklic|referenca|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
    if (!labeled) continue
    const cand = normalizeRef(labeled[2], 'labeled')
    if (!cand) continue
    // For labeled refs, allow slightly shorter; for unlabeled, keep conservative.
    if (/^SI\d{2}/i.test(cand) && cand.length < 7) continue
    if (!seen.has(cand)) { seen.add(cand); out.push(cand) }
  }

  // Fallback: scan all text, but exclude IBANs.
  const matches = text.match(refTokenRe) || []
  for (const m of matches) {
    const cand = normalizeRef(m, 'fallback')
    if (!cand) continue
    // Fallback needs to be strict: reject short SI prefixes that are common IBAN fragments.
    if (/^SI\d{2}/i.test(cand) && cand.length < 10) continue
    if (!seen.has(cand)) { seen.add(cand); out.push(cand) }
  }
  return out
}

function splitReferenceModel(reference) {
  const raw = String(reference || '').trim()
  if (!raw) return { model: null, number: null }
  const compact = raw.replace(/\s+/g, '').toUpperCase()
  const m = compact.match(/^(SI|RF)(\d{2})([0-9A-Z\-\/]{4,})$/i)
  if (!m) return { model: null, number: null }
  const prefix = m[1].toUpperCase()
  const model = `${prefix} ${m[2]}`
  const number = String(m[3] || '')
  return { model, number }
}

function extractModelAndReference(rawText) {
  const text = String(rawText || '').replace(/\r/g, '')
  const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
  if (!lines.length) return null

  const modelRe = /\bmodel\b\s*:?\s*(?:SI|RF)?\s*(\d{2})\b/i
  const sklicRe = /\b(sklic|referenca|reference|ref\.?|payment\s*reference)\b\s*:?\s*([0-9A-Z\-\/ ]{4,})/i

  // Same-line patterns first
  for (const l of lines) {
    const mModel = l.match(modelRe)
    const mSklic = l.match(sklicRe)
    if (mModel && mSklic) {
      const prefix = /\bRF\b/i.test(l) ? 'RF' : (/(^|\b)SI\b/i.test(l) ? 'SI' : 'SI')
      const model = `${prefix} ${mModel[1]}`
      const num = String(mSklic[2] || '').replace(/\s+/g, '').replace(/[^0-9A-Z\-\/]/g, '')
      if (num) return { model, number: num }
    }
  }

  // Cross-line proximity: find nearest sklic and model lines
  let sklicIdx = -1
  let sklicVal = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(sklicRe)
    if (!m) continue
    sklicIdx = i
    sklicVal = String(m[2] || '').replace(/\s+/g, '').replace(/[^0-9A-Z\-\/]/g, '')
    break
  }
  if (sklicIdx >= 0 && sklicVal) {
    let bestModel = null
    let bestDist = 999
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(modelRe)
      if (!m) continue
      const dist = Math.abs(i - sklicIdx)
      if (dist < bestDist) {
        const prefix = /\bRF\b/i.test(lines[i]) ? 'RF' : (/(^|\b)SI\b/i.test(lines[i]) ? 'SI' : 'SI')
        bestModel = `${prefix} ${m[1]}`
        bestDist = dist
      }
    }
    if (bestModel) return { model: bestModel, number: sklicVal }
  }

  // Pattern: "model 12 in sklic 2636..." or reversed
  const joined = lines.join(' ')
  const combo1 = joined.match(/model\s*:?\s*(?:SI|RF)?\s*(\d{2})\b[^\n]{0,80}?\b(sklic|referenca|reference|ref\.?|payment\s*reference)\b\s*:?\s*([0-9A-Z\-\/ ]{4,})/i)
  const combo2 = joined.match(/\b(sklic|referenca|reference|ref\.?|payment\s*reference)\b\s*:?\s*([0-9A-Z\-\/ ]{4,})[^\n]{0,80}?model\s*:?\s*(?:SI|RF)?\s*(\d{2})\b/i)
  const match = combo1 || combo2
  if (match) {
    const digits = combo1 ? match[1] : match[3]
    const numRaw = combo1 ? match[3] : match[2]
    const num = String(numRaw || '').replace(/\s+/g, '').replace(/[^0-9A-Z\-\/]/g, '')
    if (digits && num) return { model: `SI ${digits}`, number: num }
  }

  return null
}

function extractLabeledAmountCandidates(rawText) {
  const text = String(rawText || '').replace(/\r/g, '')
    const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean).filter(line => line.length > 0)
  // Prefer payable/amount-due lines; avoid VAT/tax/subtotals.
  const payableLabels = /(total\s*due|amount\s*due|balance\s*due|grand\s*total|za\s*pla\S*|za\s*pla\u010dat\S*|za\s*pla\u010dilo|za\s*pla\u010dati|payable|to\s*pay|pay\s*now)/i
  const totalLabels = /(grand\s*total|\btotal\b|\bskupaj\b)/i
  const ignoreContext = /(\bddv\b|\bvat\b|\btax\b|\bdavek\b|osnova|base\s*amount|\bsubtotal\b|sub\s*total|popust|discount|provizi\S*|fee\b|shipping|po\u0161tnina|delivery|surcharge)/i
  const currencyFromSymbol = (s) => {
    if (/€/.test(s)) return 'EUR'
    if (/[£]/.test(s)) return 'GBP'
    if (/[¥]/.test(s)) return 'JPY'
    if (/\$/.test(s)) return 'USD'
    return null
  }
  const out = []
  const labelScore = (line) => {
    const l = String(line || '')
    const hasPayable = payableLabels.test(l)
    const hasTotal = totalLabels.test(l)
    const hasIgnore = ignoreContext.test(l)
    // Ignore VAT/tax/subtotal lines unless they are explicitly payable/amount due.
    if (hasIgnore && !hasPayable) return 0
    if (hasPayable) return 8
    if (hasTotal) return 6
    return 0
  }

  const tryParseAmountFromLine = (line) => {
    const s = String(line || '')
    const codePrefix = s.match(/\b([A-Z]{3})\b\s*([0-9][0-9.,\s-]{0,24})/i)
    if (codePrefix) {
      const cur = String(codePrefix[1]).toUpperCase()
      const val = parseMoneyAmountLoose(codePrefix[2])
      if (val != null && val > 0) return { currency: cur, amount: val }
    }
    const sym = currencyFromSymbol(s)
    if (sym) {
      // Support both "63,26 €" and "€ 63,26"
      const m1 = s.match(/([0-9][0-9.,\s-]{0,24})\s*[$€£¥]/)
      const m2 = s.match(/[$€£¥]\s*([0-9][0-9.,\s-]{0,24})/)
      const picked = m1?.[1] || m2?.[1]
      const val = picked ? parseMoneyAmountLoose(picked) : null
      if (val != null && val > 0) return { currency: sym, amount: val }
    }
    return null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const score = labelScore(line)
    if (score <= 0) continue

    // 1) Same line
    const direct = tryParseAmountFromLine(line)
    if (direct) { out.push({ ...direct, line, score }); continue }

    // 2) Adjacent lines (labels and amounts are often separated into different OCR lines)
    const next = lines[i + 1]
    const prev = lines[i - 1]
    const fromNext = tryParseAmountFromLine(next)
    if (fromNext) { out.push({ ...fromNext, line: `${line} | ${next}`, score: Math.max(1, score - 1) }); continue }
    const fromPrev = tryParseAmountFromLine(prev)
    if (fromPrev) { out.push({ ...fromPrev, line: `${prev} | ${line}`, score: Math.max(1, score - 2) }); continue }
  }
  // Dedupe by currency+amount
  const uniq = []
  const seen = new Set()
  for (const x of out) {
    const key = `${x.currency}|${x.amount}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(x)
  }
  uniq.sort((a, b) => (b.score || 0) - (a.score || 0))
  return uniq
}

function buildExtractionMeta(rawText, sanitizedFields) {
  const ibansScored = extractIbanCandidates(rawText)
  const refs = extractReferenceCandidates(rawText)
  const amounts = extractLabeledAmountCandidates(rawText)

  // Only “strong” labeled candidates should trigger the review modal.
  const strongAmounts = amounts.filter((a) => (a && typeof a.score === 'number' ? a.score : 0) >= 6)

  const candidates = {
    ibans: ibansScored.map((x) => x.iban),
    references: refs,
    amounts: strongAmounts.length ? strongAmounts : amounts,
  }

  const doubt = {
    iban: !sanitizedFields?.iban && candidates.ibans.length > 1,
    reference: !sanitizedFields?.reference && candidates.references.length > 1,
    amount: (sanitizedFields?.amount == null || !sanitizedFields?.currency) && candidates.amounts.length > 1,
  }

  const required = ['supplier', 'invoice_number', 'amount', 'currency', 'due_date', 'iban', 'reference', 'purpose']
  const not_found = []
  for (const k of required) {
    if (k === 'amount') {
      const ok = typeof sanitizedFields?.amount === 'number' && Number.isFinite(sanitizedFields.amount) && sanitizedFields.amount > 0
      if (!ok) not_found.push('amount')
      continue
    }
    const v = sanitizedFields?.[k]
    if (k === 'currency' && String(v || '').toUpperCase() === 'UNKNOWN') {
      not_found.push('currency')
      continue
    }
    if (v == null) { not_found.push(k); continue }
    if (typeof v === 'string' && !String(v).trim()) not_found.push(k)
  }

  const any = Boolean(doubt.iban || doubt.reference || doubt.amount)
  return { any, doubt, candidates, not_found }
}

const EUR_IBAN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

function detectCurrencyFromText(rawText) {
  const text = String(rawText || '')
  if (/€/.test(text) || /\bEUR\b/i.test(text)) return 'EUR'
  if (/[£]/.test(text) || /\bGBP\b/i.test(text)) return 'GBP'
  if (/\bCHF\b/i.test(text)) return 'CHF'
  if (/[¥]/.test(text) || /\bJPY\b/i.test(text)) return 'JPY'
  if (/\bUSD\b/i.test(text) || /\$/.test(text)) return 'USD'
  return null
}

function currencyFromIbanCountry(iban) {
  const s = normalizeIban(iban)
  if (!s || s.length < 2) return null
  const cc = s.slice(0, 2)
  if (cc === 'GB') return 'GBP'
  if (cc === 'CH' || cc === 'LI') return 'CHF'
  if (EUR_IBAN_COUNTRIES.has(cc)) return 'EUR'
  return null
}

function getMissingKeyFields(fields) {
  const missing = []
  const supplier = String(fields?.supplier || fields?.creditor_name || '').trim()
  if (!supplier) missing.push('supplier')
  const okAmount = typeof fields?.amount === 'number' && Number.isFinite(fields.amount) && fields.amount > 0
  if (!okAmount) missing.push('amount')
  if (!String(fields?.currency || '').trim()) missing.push('currency')
  if (!String(fields?.due_date || '').trim()) missing.push('due_date')
  const hasIban = Boolean(String(fields?.iban || '').trim())
  const hasRef = Boolean(String(fields?.reference || '').trim())
  if (!hasIban && !hasRef) missing.push('iban_or_reference')
  return { missing, hasMissing: missing.length > 0 }
}

function textContainsLabeledIban(rawText, iban) {
  const s = normalizeIban(iban)
  if (!s) return false
  const raw = String(rawText || '')
  const compact = raw.toUpperCase().replace(/\s+/g, '')
  const idx = compact.indexOf(s)
  if (idx < 0) return false
  // Require an explicit label nearby to avoid accidental matches.
  const windowStart = Math.max(0, idx - 40)
  const windowEnd = Math.min(compact.length, idx + s.length + 40)
  const around = compact.slice(windowStart, windowEnd)
  return (
    around.includes('IBAN') ||
    around.includes('TRR') ||
    around.includes('RACUN') ||
    around.includes('RAČUN'.toUpperCase().replace(/\s+/g, '')) ||
    around.includes('ACCOUNT')
  )
}

function scoreIbanContext(rawText, iban) {
  const s = normalizeIban(iban)
  const raw = String(rawText || '')
  const compact = raw.toUpperCase().replace(/\s+/g, '')
  const idx = compact.indexOf(s)
  if (idx < 0) return -999
  const windowStart = Math.max(0, idx - 80)
  const windowEnd = Math.min(compact.length, idx + s.length + 80)
  const around = compact.slice(windowStart, windowEnd)

  // Strong indicators (explicit payment/bank/account labels)
  const strong = [
    // Slovenia / EU
    'IBAN',
    'TRR',
    'RACUN',
    'RAČUN'.toUpperCase().replace(/\s+/g, ''),
    'ZAPLACILO',
    'PLAČILO'.toUpperCase().replace(/\s+/g, ''),
    'NAKAZILO',
    // International
    'PAYMENT',
    'PAYEE',
    'BENEFICIARY',
    'BANK',
    'BANKDETAILS',
    'ACCOUNT',
    'ACCOUNTNO',
    'A/C',
    'A\C',
    'SWIFT',
    'BIC',
    'WIRE',
    'TRANSFER',
    // UK / AU / US labels (even if not IBAN-based, they signal the bank-details area)
    'SORTCODE',
    'BSB',
    'ROUTING',
    'ABAROUTING',
    'ABA',
  ]

  // Weaker indicators
  const weak = [
    'SEPA',
    'SCT',
    'REMITTANCE',
    'REFERENCE',
    'PAYMENTREFERENCE',
    'DETAILS',
    'DUE',
    'PAYBY',
  ]

  let score = 0
  for (const k of strong) if (around.includes(k)) score += 3
  for (const k of weak) if (around.includes(k)) score += 1
  // Prefer domestic SI IBAN slightly when ambiguous.
  if (s.startsWith('SI')) score += 1
  return score
}

function pickBestIbanFromText(rawText) {
  // Extract IBAN-like sequences without merging across newlines.
  // IMPORTANT: do not remove all whitespace before matching, otherwise we may
  // accidentally glue the IBAN to the next line label (e.g. "...67892SKLIC").
  const upper = String(rawText || '').toUpperCase()
  const found = upper.match(/\b[A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,34}\b/g) || []
  const unique = [...new Set(found.map(normalizeIban).filter(isValidIbanChecksum))]
  if (unique.length === 0) return { iban: null, reason: 'none' }
  if (unique.length === 1) return { iban: unique[0], reason: 'single' }

  const scored = unique
    .map((iban) => ({ iban, score: scoreIbanContext(rawText, iban) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  const second = scored[1]
  // Only accept if we have a clear winner with a decent score.
  if (best.score >= 4 && best.score >= (second.score + 2)) {
    return { iban: best.iban, reason: 'scored_unique_best' }
  }

  // If multiple IBANs are present but exactly one has an explicit label, accept it.
  const labeled = unique.filter((iban) => textContainsLabeledIban(rawText, iban))
  if (labeled.length === 1) return { iban: labeled[0], reason: 'single_labeled' }

  return { iban: null, reason: 'ambiguous_multi' }
}

function textContainsReference(rawText, ref) {
  const s = String(ref || '').replace(/\s+/g, '').toUpperCase()
  if (!s) return false
  const compact = String(rawText || '').replace(/\s+/g, '').toUpperCase()
  return compact.includes(s)
}

function splitLines(rawText) {
  return String(rawText || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((l) => String(l || '').trim())
    .filter(Boolean)
}

function isUrlOrEmailLike(input) {
  const s = String(input || '').trim()
  if (!s) return false
  return /(\bhttps?:\/\/|\bwww\.|\.(?:com|si|net)\b|@)/i.test(s)
}

function hasLegalSuffix(input) {
  const s = String(input || '').replace(/\s+/g, ' ').trim()
  if (!s) return false
  // Avoid \b around suffixes that end with '.' (\b doesn't match after a non-word char).
  // Accept common spacing/dot variants (e.g. d o o, d.o.o, d.o.o.).
  return /(?:^|[^A-Za-z0-9])(?:d\s*\.?\s*o\s*\.?\s*o\s*\.?|d\s*\.?\s*d\s*\.?|s\s*\.?\s*p\s*\.?|gmbh|ag|srl|s\s*\.?\s*p\s*\.?\s*a\s*\.?|ltd|llc|inc|bv|oy|ab|kg|sas|sa|nv|plc)(?:$|[^A-Za-z0-9])/i.test(s)
}

function isCustomerLabelLine(input) {
  const s = String(input || '')
  return /\b(kupec|odjemalec|pla\u010dnik|placnik|payer|customer|buyer|bill\s*to|sold\s*to|recipient|destinatario|cliente|empf[a\u00e4]nger)\b/i.test(s)
}

function isLikelyAddressOnly(input) {
  const s = String(input || '').replace(/\s+/g, ' ').trim()
  if (!s) return true
  if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) return true
  // Street/address keywords + a number, or ZIP/postal patterns.
  if (/\b(ulica|cesta|street|st\.?|road|rd\.?|avenue|ave\.?|strasse|stra\u00dfe|via|trg|naselje|posta|po\u0161t\S*|zip)\b/i.test(s) && /\d{1,4}\b/.test(s)) return true
  if (/\b\d{4,6}\b/.test(s) && !hasLegalSuffix(s) && s.length <= 40) return true
  return false
}

function parseDateToken(token, hintIsEnglish) {
  const t = String(token || '').trim()
  if (!t) return null
  const compact = t.replace(/\s/g, '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(compact)) return compact
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(compact)) return compact.replace(/\//g, '-')

  const m = compact.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/)
  if (!m) return null
  let a = Number(m[1])
  let b = Number(m[2])
  let y = Number(m[3])
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(y)) return null
  if (y < 100) y = y >= 70 ? 1900 + y : 2000 + y

  const delim = compact.includes('/') ? '/' : (compact.includes('.') ? '.' : '-')
  const aIsDay = a > 12 && a <= 31
  const bIsDay = b > 12 && b <= 31

  let day
  let month
  if (aIsDay && !bIsDay) {
    day = a
    month = b
  } else if (bIsDay && !aIsDay) {
    day = b
    month = a
  } else {
    const assumeMonthFirst = hintIsEnglish && delim === '/'
    if (assumeMonthFirst) {
      month = a
      day = b
    } else {
      day = a
      month = b
    }
  }

  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

function normalizeCompanyNameCandidate(input) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim()
  if (!raw) return null

  const prefixRe = /^(?:uporabnik|obrazec|ra\u010dun|racun|dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor|customer|payer|bill\s*to|sold\s*to|izdajatelj|prodajalec|izdal)\s*[:\-]?\s*/i
  const parts = raw
    .split(/[|•·]/)
    .map((p) => p.replace(prefixRe, '').replace(/^[\s:,-]+|[\s:,-]+$/g, '').trim())
    .filter(Boolean)

  const cleaned = parts
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => !isUrlOrEmailLike(p))
    .filter((p) => !isLikelyAddressOnly(p))
    .filter((p) => /[A-Za-zÀ-žČŠŽčšž]/.test(p))

  if (!cleaned.length) return null
  const withSuffix = cleaned.filter((p) => hasLegalSuffix(p))
  const pickFrom = withSuffix.length ? withSuffix : cleaned
  pickFrom.sort((a, b) => a.length - b.length)
  return pickFrom[0] || null
}

function isStrongCompanyNameCandidate(input) {
  const s = String(input || '').replace(/\s+/g, ' ').trim()
  if (!s) return false
  if (isUrlOrEmailLike(s)) return false
  if (isLikelyAddressOnly(s)) return false
  if (isCustomerLabelLine(s)) return false
  if (looksLikeMisassignedName(s)) return false
  if (/\b(intro|marketing|advert|promo|page|stran|header|obvestilo)\b/i.test(s)) return false
  if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) return false
  const digits = (s.match(/\d/g) || []).length
  const letters = (s.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
  if (letters < 4) return false
  if (digits > letters) return false
  if (s.length < 3 || s.length > 60) return false
  const words = s.split(' ').filter(Boolean)
  if (words.length > 6) return false
  return true
}

function extractIssuerFromHeaderBlock(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return null

  const headerCount = Math.max(1, Math.min(40, Math.ceil(lines.length * 0.25)))
  const header = lines.slice(0, headerCount)

  const taxOrContact = /\b(ddv|vat|tax|id\s*no|mati\u010dna|maticna|reg\.?\s*no|registration|tel\.?|phone|fax)\b/i

  const scoreLine = (line, idx) => {
    const raw = String(line || '').replace(/\s+/g, ' ').trim()
    if (!raw) return { score: -999, value: '' }

    // Reject obvious non-issuer structural lines.
    if (/^[-_]{3,}$/.test(raw) || /\bpage\b|\bstran\b|\bheader\b/i.test(raw)) return { score: -999, value: '' }

    // Strip common issuer/payee label prefixes.
    const stripped = raw.match(/^(?:dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor)\s*:?(?:\s+)?(.+)$/i)
    const fromLabel = Boolean(stripped)
    const s = String(stripped?.[1] || raw).replace(/\s+/g, ' ').trim()
    if (!s) return { score: -999, value: '' }
    if (isUrlOrEmailLike(s)) return { score: -999, value: '' }
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) return { score: -999, value: '' }
    if (looksLikeMisassignedName(s)) return { score: -999, value: '' }
    if (isCustomerLabelLine(raw) || isCustomerLabelLine(s)) return { score: -999, value: '' }
    if (isLikelyAddressOnly(s)) return { score: -999, value: '' }

    // Reject pure payment labels.
    if (/\b(iban|trr|sklic|referenca|reference|model|namen|purpose|znesek|rok\s*pla\S*|zapad|due\s*date)\b/i.test(raw)) return { score: -50, value: '' }

    let score = 0
    // Strong preference for legal suffix.
    if (hasLegalSuffix(s)) score += 10
    // Prefer earlier lines.
    score += Math.max(0, 6 - Math.floor(idx / 5))
    // Prefer company-like names.
    const digits = (s.match(/\d/g) || []).length
    const letters = (s.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
    if (letters >= 8 && digits <= 2) score += 3
    if (s.length >= 4 && s.length <= 60) score += 2
    // Boost if near tax/contact markers.
    const window = [header[idx - 2], header[idx - 1], header[idx], header[idx + 1], header[idx + 2]].filter(Boolean).join(' ')
    const hasContext = taxOrContact.test(window) || fromLabel
    if (taxOrContact.test(window)) score += 4
    // If GEN-I appears, boost (safe brand/company marker).
    const hasGenI = /\bGEN\s*-?\s*I\b/i.test(s)
    if (hasGenI) score += 8
    const strongName = isStrongCompanyNameCandidate(s)
    if (strongName) score += 2

    // Hard requirement: issuer must have either a legal suffix, a strong header context, GEN-I marker, or a strong company-like line.
    if (!hasLegalSuffix(s) && !hasContext && !hasGenI && !strongName) return { score: -999, value: '' }
    return { score, value: s }
  }

  let best = null
  let bestScore = -1
  for (let i = 0; i < header.length; i++) {
    const sc = scoreLine(header[i], i)
    if (sc.score > bestScore) {
      bestScore = sc.score
      best = sc.value
    }
  }
  const picked = bestScore >= 6 ? String(best || '').replace(/\s+/g, ' ').trim() : null
  return picked || null
}

function extractPayerNameFromText(rawText, issuer) {
  const lines = splitLines(rawText)
  if (!lines.length) return null
  const issuerNorm = String(issuer || '').replace(/\s+/g, ' ').trim().toUpperCase()

  const startRe = /^(?:kupec|odjemalec|pla\u010dnik|placnik|customer|buyer|bill\s*to|sold\s*to|recipient|destinatario|cliente|empf[a\u00e4]nger)\b\s*:?(.*)$/i
  const stopRe = /\b(iban|trr|sklic|referenca|reference|model|rok\s*pla\S*|due\s*date|znesek|amount|total|invoice|ra\u010dun)\b/i

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = String(l || '').match(startRe)
    if (!m) continue

    const direct = String(m[1] || '').trim()
    const candidates = []
    if (direct) candidates.push(direct)

    // Collect a few following lines until we hit another block.
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const x = String(lines[j] || '').trim()
      if (!x) break
      if (stopRe.test(x) && !hasLegalSuffix(x)) break
      candidates.push(x)
    }

    for (const c of candidates) {
      const v = String(c || '').replace(/\s+/g, ' ').trim()
      if (!v) continue
      if (isUrlOrEmailLike(v)) continue
      if (looksLikeMisassignedName(v)) continue
      if (isLikelyAddressOnly(v)) continue
      const vNorm = v.toUpperCase()
      if (issuerNorm && vNorm === issuerNorm) continue
      // Avoid selecting obvious issuer lines.
      if (issuerNorm && issuerNorm.includes(vNorm)) continue
      if (v.length < 2 || v.length > 70) continue
      return v
    }
  }

  return null
}

function extractInvoiceNumberLabeled(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return null

  const labelRe = /\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#|nr\.?|no\.?)|\u0161tevilka\s*ra\u010duna|ra\u010dun\s*\u0161tevilka|invoice\s*(?:no\.?|#|number|nr\.?)?|document\s*(?:no\.?|#|number|nr\.?)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka|nr\.?)?)\b/i
  const valueRe = /\b([A-Z0-9][A-Z0-9\-\/.]{2,})\b/i

  const normalize = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
  const isBad = (v) => {
    const s = normalize(v)
    if (!s) return true
    if (!/\d/.test(s)) return true
    if (s.length < 3 || s.length > 32) return true
    if (isValidIbanChecksum(s)) return true
    if (/^(SI|RF)\d{2}[0-9A-Z\-\/]{4,}$/i.test(s)) return true
    if (/^GEN\s*[-_]?\s*1$/i.test(v) || /^GEN\s*[-_]?\s*I$/i.test(v)) return true
    if (isUrlOrEmailLike(v)) return true
    return false
  }

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    if (!labelRe.test(l)) continue
    const inline = l.match(new RegExp(`${labelRe.source}\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9\\-\\/.]{2,})`, 'i'))
    if (inline?.[1] && !isBad(inline[1])) return normalize(inline[1])
    const after = String(l.split(/:\s*/, 2)[1] || '').trim()
    const directToken = (after.match(valueRe) || [])[1] || after
    if (directToken && !isBad(directToken)) return normalize(directToken)
    const next = String(lines[i + 1] || '').trim()
    const nxtTok = (next.match(valueRe) || [])[1]
    if (nxtTok && !isBad(nxtTok)) return normalize(nxtTok)
  }

  return null
}

function hasInvoiceLabelEvidence(rawText, invoiceNumber) {
  const inv = String(invoiceNumber || '').trim()
  if (!inv) return false
  const invNorm = inv.toUpperCase().replace(/\s+/g, '')
  const lines = splitLines(rawText)
  if (!lines.length) return false

  const labelRe = /\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#|nr\.?|no\.?)|\u0161tevilka\s*ra\u010duna|ra\u010dun\s*\u0161tevilka|invoice\s*(?:no\.?|#|number|nr\.?)?|document\s*(?:no\.?|#|number|nr\.?)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka|nr\.?)?)\b/i

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    const lineNorm = l.toUpperCase().replace(/\s+/g, '')
    if (!lineNorm.includes(invNorm)) continue
    if (labelRe.test(l)) return true
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
      if (labelRe.test(String(lines[j] || ''))) return true
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    if (!labelRe.test(l)) continue
    const after = String(l.split(/:\s*/, 2)[1] || '').trim()
    const directToken = (after.match(/\b([A-Z0-9][A-Z0-9\-\/.]{2,})\b/i) || [])[1] || after
    const directNorm = String(directToken || '').toUpperCase().replace(/\s+/g, '')
    if (directNorm && directNorm.includes(invNorm)) return true
    const next = String(lines[i + 1] || '').trim()
    const nextNorm = next.toUpperCase().replace(/\s+/g, '')
    if (nextNorm && nextNorm.includes(invNorm)) return true
  }

  return false
}

function extractMeaningfulDescription(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return null

  // Prefer labeled purpose/description if present.
  for (const l of lines) {
    const m = l.match(/^(?:namen(?:\s+pla\S*)?|opis(?:\s+pla\S*)?|purpose|memo|description|payment\s*for)\s*:?\s*(.+)$/i)
    if (!m) continue
    const v = String(m[1] || '').replace(/\s+/g, ' ').trim()
    if (v && v.length >= 4) return v
  }

  // Unlabeled: very conservative service+period line.
  const monthSl = /(januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december)\s+20\d{2}/i
  const monthEn = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}/i
  const period = new RegExp(`(?:${monthSl.source})|(?:${monthEn.source})`, 'i')
  const service = /(elektri\S*\s*energija|electric\S*\s*energy|electricity|power\b|plin\b|gas\b|internet\b|zavarovanj\S*|komunal\S*|voda\b|waste\b|heating|ogrevanj\S*)/i
  const ignore = /(iban|trr|sklic|referenca|reference|model|rok\s*pla\S*|zapad|znesek|amount|total|ddv|vat|subtotal|grand\s*total|\btotal\b|invoice|ra\u010dun\s*(?:\u0161t|st|#))/i

  let best = null
  let bestScore = -1
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').replace(/\s+/g, ' ').trim()
    if (!l || l.length < 6 || l.length > 90) continue
    if (ignore.test(l)) continue
    if (isUrlOrEmailLike(l)) continue
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(l)) continue

    let score = 0
    if (service.test(l)) score += 3
    if (period.test(l)) score += 3
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  if (bestScore >= 6 && best) return best
  return null
}

function extractItemNameFromText(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return null

  const labelRe = /^(?:naziv\s+izdelka|izdelek|artikel|artikl|opis|description|product|item|storitev|service)\b\s*:?-?\s*(.+)$/i
  const badRe = /(iban|trr|sklic|referenca|reference|model|rok\s*pla\S*|zapad|znesek|amount|total|ddv|vat|subtotal|grand\s*total|\btotal\b|invoice|ra\u010dun)/i

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    const m = l.match(labelRe)
    if (m && m[1]) {
      const v = String(m[1]).replace(/\s+/g, ' ').trim()
      if (v && v.length >= 4 && v.length <= 120 && !badRe.test(v) && !isUrlOrEmailLike(v)) return v
    }
  }

  const meaningful = extractMeaningfulDescription(rawText)
  if (meaningful && meaningful.length >= 4 && meaningful.length <= 120) return meaningful

  return null
}

function extractInvoiceNumberCandidates(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return []

  const labelRe = /\b(?:ra\u010dun\s*(?:\u0161t\.?|st\.?|#)|\u0161tevilka\s*ra\u010duna|ra\u010dun\s*\u0161tevilka|invoice\s*(?:no\.?|#|number)?|document\s*(?:no\.?|#|number)?|dokument\s*(?:\u0161t\.?|st\.?|#|\u0161tevilka)?)\b/i
  const valueRe = /\b([A-Z0-9][A-Z0-9\-\/.]{2,})\b/i

  const normalize = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '')
  const isBad = (v) => {
    const s = normalize(v)
    if (!s) return true
    if (!/\d/.test(s)) return true
    if (s.length < 3 || s.length > 32) return true
    if (isValidIbanChecksum(s)) return true
    if (/^(SI|RF)\d{2}[0-9A-Z\-\/]{4,}$/i.test(s)) return true
    if (/^GEN\s*[-_]?\s*1$/i.test(v) || /^GEN\s*[-_]?\s*I$/i.test(v)) return true
    if (isUrlOrEmailLike(v)) return true
    return false
  }

  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l || !labelRe.test(l)) continue
    const inline = l.match(new RegExp(`${labelRe.source}\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9\\-\\/.]{2,})`, 'i'))
    if (inline?.[1] && !isBad(inline[1])) out.push({ value: normalize(inline[1]), evidence: l })
    const after = String(l.split(/:\s*/, 2)[1] || '').trim()
    const directToken = (after.match(valueRe) || [])[1] || after
    if (directToken && !isBad(directToken)) out.push({ value: normalize(directToken), evidence: l })
    const next = String(lines[i + 1] || '').trim()
    const nxtTok = (next.match(valueRe) || [])[1]
    if (nxtTok && !isBad(nxtTok)) out.push({ value: normalize(nxtTok), evidence: next })
  }
  const uniq = new Map()
  for (const c of out) {
    const key = c.value
    if (!uniq.has(key)) uniq.set(key, c)
  }
  return Array.from(uniq.values())
}

function extractDueDateCandidates(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return []
  const dueLabel = /(rok\s*pla[^\s:]*|zapad[^\s:]*|due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by|f[äa]llig[^\s:]*|zahlbar\s*bis|scadenza|scad\.?\b|[ée]ch[ée]ance|vencim\S*|vencimiento)/i
  const dateToken = /(\d{4}[-\/]\d{2}[-\/]\d{2}|\d{1,2}[\.\/-]\d{1,2}[\.\/-]\d{2,4})/
  const out = []

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    if (!dueLabel.test(l)) continue
    const inline = l.match(dateToken)
    const hintEnglish = /(due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by)/i.test(l)
    if (inline?.[1]) {
      const iso = parseDateToken(inline[1], hintEnglish)
      if (iso) out.push({ value: iso, evidence: l })
    } else {
      const next = String(lines[i + 1] || '').trim()
      const m = next.match(dateToken)
      if (m?.[1]) {
        const iso = parseDateToken(m[1], hintEnglish)
        if (iso) out.push({ value: iso, evidence: `${l} ${next}` })
      }
    }
  }

  const uniq = new Map()
  for (const c of out) {
    const key = c.value
    if (!uniq.has(key)) uniq.set(key, c)
  }
  return Array.from(uniq.values())
}

function buildCompanyNameCandidates(rawText) {
  const lines = splitLines(rawText)
  if (!lines.length) return []

  const out = []
  const labelRe = /^(?:dobavitelj|supplier|vendor|seller|issuer|prejemnik|recipient|payee|beneficiary|creditor|uporabnik|izdajatelj|prodajalec|izdal)\b\s*:?\s*(.+)$/i
  const headerCount = Math.max(1, Math.min(40, Math.ceil(lines.length * 0.25)))

  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim()
    if (!l) continue
    const m = l.match(labelRe)
    if (m?.[1]) {
      const normalized = normalizeCompanyNameCandidate(m[1])
      if (normalized) out.push({ value: normalized, evidence: l })
    }
  }

  const header = lines.slice(0, headerCount)
  for (const h of header) {
    const normalized = normalizeCompanyNameCandidate(h)
    if (normalized && (hasLegalSuffix(normalized) || isStrongCompanyNameCandidate(normalized))) out.push({ value: normalized, evidence: h })
  }

  // Broader pass: any line with a legal suffix (often company name), even outside header.
  for (const l of lines) {
    const normalized = normalizeCompanyNameCandidate(l)
    if (normalized && hasLegalSuffix(normalized)) out.push({ value: normalized, evidence: l })
  }

  const issuerHeader = extractIssuerFromHeaderBlock(rawText)
  if (issuerHeader) {
    const normalized = normalizeCompanyNameCandidate(issuerHeader)
    if (normalized) out.push({ value: normalized, evidence: issuerHeader })
  }

  const uniq = new Map()
  for (const c of out) {
    const key = c.value.toUpperCase()
    if (!uniq.has(key)) uniq.set(key, c)
  }
  return Array.from(uniq.values())
}

function buildFieldCandidates(rawText) {
  const candidates = {
    supplier: [],
    creditor_name: [],
    invoice_number: [],
    amount: [],
    due_date: [],
    iban: [],
    reference: [],
    payer_name: [],
    purpose: [],
    item_name: [],
  }

  const add = (list, value, evidence) => {
    if (!value) return
    list.push({ value, evidence: evidence || String(value || '') })
  }

  const companyCandidates = buildCompanyNameCandidates(rawText)
  for (const c of companyCandidates) {
    add(candidates.supplier, c.value, c.evidence)
    add(candidates.creditor_name, c.value, c.evidence)
  }

  for (const c of extractInvoiceNumberCandidates(rawText)) add(candidates.invoice_number, c.value, c.evidence)
  for (const c of extractDueDateCandidates(rawText)) add(candidates.due_date, c.value, c.evidence)

  const ibanCandidates = extractIbanCandidates(rawText).map((x) => x.iban)
  for (const v of ibanCandidates) add(candidates.iban, v, v)

  const refCandidates = extractReferenceCandidates(rawText)
  for (const v of refCandidates) add(candidates.reference, v, v)

  const amountCandidates = extractLabeledAmountCandidates(rawText)
  for (const c of amountCandidates) {
    if (!c || typeof c.amount !== 'number' || !c.currency) continue
    add(candidates.amount, { amount: c.amount, currency: c.currency }, c.line || `${c.amount} ${c.currency}`)
  }

  const issuer = extractIssuerFromHeaderBlock(rawText)
  const payer = extractPayerNameFromText(rawText, issuer)
  if (payer) add(candidates.payer_name, payer, payer)

  const meaningful = extractMeaningfulDescription(rawText)
  if (meaningful) add(candidates.purpose, meaningful, meaningful)

  const item = extractItemNameFromText(rawText)
  if (item) add(candidates.item_name, item, item)

  return candidates
}

function addDaysIso(isoDate, days) {
  const base = new Date(`${String(isoDate).slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(base.getTime())) return null
  base.setUTCDate(base.getUTCDate() + Number(days || 0))
  return base.toISOString().slice(0, 10)
}

function pickDocRefDateStamp(out) {
  const due = String(out?.due_date || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due.replace(/-/g, '')

  // Try issue date labels.
  const text = String(out?._rawTextForRef || '')
  const m1 = text.match(/\b(?:datum\s*izdaje|issue\s*date|datum)\s*:?\s*(\d{4}[-\/]\d{2}[-\/]\d{2}|\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})\b/i)
  if (m1) {
    // Best-effort parse: reuse the extractFields date parser indirectly by accepting ISO-only; otherwise ignore.
    const token = String(m1[1] || '').trim()
    const iso = token.match(/^\d{4}-\d{2}-\d{2}$/) ? token : null
    if (iso) return iso.replace(/-/g, '')
  }

  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

function generateInternalDocRef(dateStamp, seq = '001') {
  const ds = String(dateStamp || '').replace(/[^0-9]/g, '').slice(0, 8)
  const safe = ds.length === 8 ? ds : new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const n = String(seq || '001').replace(/[^0-9]/g, '').padStart(3, '0').slice(0, 3)
  return `DOC-${safe}-${n}`
}

function sanitizeFields(rawText, fields) {
  const out = { ...fields }
  out._rawTextForRef = rawText

  const rawTextStr = String(rawText || '')
  const firstLine = String(rawTextStr.split(/\r?\n/)[0] || '').trim()
  const isQrText = firstLine === 'BCD' || /\bUPNQR\b/i.test(rawTextStr)

  const reviewReasons = []

  // IBAN
  if (isQrText) {
    // QR mapping is deterministic: validate what QR provided; do not attempt OCR heuristics.
    if (out.iban) {
      const iban = normalizeIban(out.iban)
      out.iban = isValidIbanChecksum(iban) ? iban : null
    } else {
      out.iban = null
    }
  } else {
    // OCR/PDF: never guess. If multiple are present, only auto-pick a clearly best candidate.
    const best = pickBestIbanFromText(rawText)
    if (out.iban) {
      const iban = normalizeIban(out.iban)
      if (!isValidIbanChecksum(iban)) out.iban = null
      else if (best.iban && iban === best.iban) out.iban = iban
      else if (textContainsLabeledIban(rawText, iban) && best.reason !== 'ambiguous_multi') out.iban = iban
      else out.iban = best.iban || null
    } else {
      out.iban = best.iban || null
    }
  }

  // Reference: accept SIxx/RFxx; never discard valid references as “IBAN fragments”.
  const bestRefs = isQrText ? [] : extractReferenceCandidates(rawText)
  const normalizeRef = (r) => String(r || '').replace(/\s+/g, '').toUpperCase()
  const isValidRef = (r) => {
    const v = normalizeRef(r)
    if (!v) return false
    if (!/^(SI|RF)\d{2}/i.test(v)) return false
    if (v.length < 6) return false
    if (isValidIbanChecksum(v)) return false
    return true
  }
  if (out.reference) {
    const r = normalizeRef(out.reference)
    if (!isValidRef(r) && !textContainsReference(rawText, r)) out.reference = null
    else out.reference = r
  }
  if (!out.reference && bestRefs.length) {
    const cand = bestRefs.find(isValidRef) || null
    out.reference = cand ? normalizeRef(cand) : null
  }

  // Derive model/number from reference when possible.
  if (out.reference) {
    const split = splitReferenceModel(out.reference)
    if (split.model && split.number) {
      out.reference_model = split.model
      out.reference_number = split.number
    }
  } else if (out.reference_model && out.reference_number) {
    const modelCompact = String(out.reference_model || '').replace(/\s+/g, '').toUpperCase()
    const num = String(out.reference_number || '').replace(/\s+/g, '').toUpperCase()
    if (modelCompact && num) out.reference = `${modelCompact}${num}`
  }

  // Amount: keep only reasonable numbers; if missing, try labeled amount candidates.
  if (typeof out.amount === 'number') {
    if (!Number.isFinite(out.amount) || out.amount <= 0 || out.amount > 1000000) out.amount = null
  }
  if (out.amount == null) {
    const labeledAmounts = extractLabeledAmountCandidates(rawText)
    const bestAmount = labeledAmounts.find((a) => a && typeof a.amount === 'number' && a.amount > 0 && a.currency) || null
    if (bestAmount) {
      out.amount = bestAmount.amount
      out.currency = bestAmount.currency
    }
  }
  // Amount without a currency: attempt inference (symbols/labels/IBAN country); otherwise mark UNKNOWN.
  if (typeof out.amount === 'number' && !out.currency) {
    const inferred = detectCurrencyFromText(rawText) || currencyFromIbanCountry(out.iban)
    out.currency = inferred || 'UNKNOWN'
  }
  if (out.currency && !/^[A-Z]{3}$/.test(String(out.currency)) && String(out.currency).toUpperCase() !== 'UNKNOWN') out.currency = null

  // Due date: ISO only; for non-QR sources default to today + 14 days and mark needsReview.
  if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(out.due_date))) out.due_date = null
  if (!out.due_date && !isQrText) {
    const todayIso = new Date().toISOString().slice(0, 10)
    const fallback = addDaysIso(todayIso, 14)
    if (fallback) {
      out.due_date = fallback
      reviewReasons.push('due_date_defaulted')
    }
  }
  if (!out.due_date) out.due_date = null

  // Issuer (supplier/recipient): invoice issuer from header block (non-QR); never a domain/URL.
  const issuerFromHeader = isQrText ? null : extractIssuerFromHeaderBlock(rawText)
  const normalizeName = (s) => normalizeCompanyNameCandidate(s)
  const isAcceptableIssuerName = (s) => {
    const v = normalizeName(s)
    if (!v) return false
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(v)) return false
    if (looksLikeMisassignedName(v)) return false
    if (isUrlOrEmailLike(v)) return false
    return true
  }
  const cleanedSupplier = out.supplier && typeof out.supplier === 'string' ? normalizeName(out.supplier) : null
  const cleanedCreditor = out.creditor_name && typeof out.creditor_name === 'string' ? normalizeName(out.creditor_name) : null

  // Prefer evidence-based header issuer, then any upstream supplier, then creditor_name.
  // Crucially: do not let a URL-like creditor_name wipe out a valid supplier/header.
  const issuerCandidate = [issuerFromHeader, cleanedSupplier, cleanedCreditor].find((c) => isAcceptableIssuerName(c)) || null
  const issuer = issuerCandidate ? normalizeName(issuerCandidate) : null
  if (issuer) {
    out.creditor_name = issuer
    out.supplier = issuer
  } else {
    out.creditor_name = null
    out.supplier = null
  }

  // Payer: invoice addressee (only for fallback purpose); never equal issuer.
  const payer = isQrText ? null : extractPayerNameFromText(rawText, issuer)
  out.payer_name = payer || null

  // Invoice number: ONLY labeled extraction; for non-QR sources, generate internal DOC-YYYYMMDD-XXX when missing.
  const invLabeled = isQrText ? null : extractInvoiceNumberLabeled(rawText)
  out.invoice_number = invLabeled || (typeof out.invoice_number === 'string' ? String(out.invoice_number).trim() : null)
  // If we have an invoice_number from upstream, accept it only if it appears in a labeled context.
  if (out.invoice_number && !invLabeled) {
    const probe = String(out.invoice_number || '').trim().toUpperCase().replace(/\s+/g, '')
    if (!hasInvoiceLabelEvidence(rawText, probe)) out.invoice_number = null
    else out.invoice_number = probe
  }
  if (!out.invoice_number && !isQrText) {
    const stamp = pickDocRefDateStamp(out)
    out.invoice_number = generateInternalDocRef(stamp, '001')
    reviewReasons.push('invoice_number_generated')
  }

  // Purpose MUST always be filled for OCR/PDF mapping. For QR, keep only what QR provided.
  const meaningful = isQrText ? null : extractMeaningfulDescription(rawText)
  const inv = String(out.invoice_number || '').trim()
  const payerName = String(out.payer_name || '').trim()
  if (meaningful) out.purpose = meaningful
  else if (!isQrText && inv) out.purpose = `Plačilo ${inv}`
  else if (!isQrText && payerName) out.purpose = `Plačilo ${payerName}`
  else if (!isQrText) out.purpose = 'Plačilo'
  else out.purpose = out.purpose ? String(out.purpose).trim() || null : null

  if (out.payment_details && typeof out.payment_details === 'string') {
    const s = out.payment_details.trim()
    out.payment_details = s ? (s.length > 1200 ? s.slice(0, 1200) : s) : null
  }

  // Required (*) fields for the bill form (issuer, invoice, amount, due date, purpose)
  const missingFields = []
  if (!out.supplier) missingFields.push('supplier')
  if (!out.invoice_number) missingFields.push('invoice_number')
  const okAmt = typeof out.amount === 'number' && Number.isFinite(out.amount) && out.amount > 0
  if (!okAmt) missingFields.push('amount')
  if (!out.due_date) missingFields.push('due_date')
  if (!out.purpose) missingFields.push('purpose')

  out.missingFields = missingFields
  out.reviewReasons = reviewReasons
  out.needsReview = Boolean(missingFields.length > 0 || reviewReasons.length > 0)
  delete out._rawTextForRef

  return out
}

function sanitizeFieldsAiOnly(fields) {
  const out = { ...fields }

  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()
  const upper = (v) => clean(v).toUpperCase()

  // Supplier / creditor
  const rawIssuer = clean(out.supplier || out.creditor_name || '')
  const issuerCandidate = normalizeCompanyNameCandidate(rawIssuer)
  if (issuerCandidate && !looksLikeMisassignedName(issuerCandidate)) {
    out.supplier = issuerCandidate
    out.creditor_name = issuerCandidate
  } else if (rawIssuer) {
    const compact = rawIssuer.split(/\n+/)[0].trim()
    const trimmed = compact.length > 80 ? compact.slice(0, 80).trim() : compact
    out.supplier = trimmed || null
    out.creditor_name = trimmed || null
  } else {
    out.supplier = null
    out.creditor_name = null
  }

  // Payer
  out.payer_name = clean(out.payer_name) || null

  // Invoice number
  if (out.invoice_number) {
    const v = upper(out.invoice_number).replace(/\s+/g, '')
    const bad =
      !/\d/.test(v) ||
      v.length < 2 ||
      v.length > 40 ||
      isValidIbanChecksum(v) ||
      /^(SI|RF)\d{2}[0-9A-Z\-\/]{4,}$/i.test(v) ||
      /^\d{4}-\d{2}-\d{2}$/.test(v)
    out.invoice_number = bad ? null : v
  } else {
    out.invoice_number = null
  }

  // Amount / currency
  if (typeof out.amount !== 'number' || !Number.isFinite(out.amount) || out.amount <= 0 || out.amount > 1000000) out.amount = null
  if (out.currency) {
    const cur = upper(out.currency)
    out.currency = /^[A-Z]{3}$/.test(cur) ? cur : null
  } else {
    out.currency = null
  }

  // Due date
  if (out.due_date) {
    const d = clean(out.due_date)
    out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : (parseDateToken(d, false) || null)
  } else {
    out.due_date = null
  }

  // IBAN
  if (out.iban) {
    const iban = normalizeIban(out.iban)
    out.iban = isValidIbanChecksum(iban) ? iban : null
  } else {
    out.iban = null
  }

  // Reference
  if (out.reference) {
    const r = normalizeReferenceSimple(out.reference)
    if ((r || '').length < 6 || (r && isValidIbanChecksum(r))) out.reference = null
    else out.reference = r
  } else {
    out.reference = null
  }

  if (out.reference) {
    const split = splitReferenceModel(out.reference)
    if (split.model && split.number) {
      out.reference_model = split.model
      out.reference_number = split.number
    }
  }

  // Purpose / item
  out.purpose = clean(out.purpose) || null
  out.item_name = clean(out.item_name) || null
  if (!out.purpose && out.item_name) out.purpose = out.item_name

  // Payment details: keep only if short and non-empty
  if (out.payment_details && typeof out.payment_details === 'string') {
    const s = out.payment_details.trim()
    out.payment_details = s ? (s.length > 1200 ? s.slice(0, 1200) : s) : null
  } else {
    out.payment_details = null
  }

  // Required fields
  const missingFields = []
  if (!out.supplier) missingFields.push('supplier')
  if (!out.invoice_number) missingFields.push('invoice_number')
  const okAmt = typeof out.amount === 'number' && Number.isFinite(out.amount) && out.amount > 0
  if (!okAmt) missingFields.push('amount')
  if (!out.due_date) missingFields.push('due_date')
  if (!out.purpose) missingFields.push('purpose')

  out.missingFields = missingFields
  out.reviewReasons = []
  out.needsReview = Boolean(missingFields.length > 0)

  return out
}

async function extractFieldsFromImageWithAI({ base64Image, contentType, languageHint, requestId }) {
  if (!isAiOcrEnabled()) return { error: 'ai_disabled' }
  if (!base64Image) return { error: 'missing_image' }

  const dataUrl = base64Image.startsWith('data:') ? base64Image : `data:${contentType || 'image/jpeg'};base64,${base64Image}`

  const system =
    'You are a document understanding assistant for invoices and payment slips. Return JSON ONLY with this schema: ' +
    '{"supplier": string|null, "creditor_name": string|null, "payer_name": string|null, "invoice_number": string|null, "amount": number|null, "currency": string|null, "due_date": string|null, "iban": string|null, "reference": string|null, "purpose": string|null, "item_name": string|null}. ' +
    'Rules: ' +
    '- Extract the issuer/supplier company name only (no labels, no addresses, no emails, no URLs). ' +
    '- invoice_number must be the invoice/document number. ' +
    '- due_date must be in YYYY-MM-DD. ' +
    '- amount must be numeric and currency 3-letter code (e.g., EUR). ' +
    '- If a value is unclear, return null. Prefer best-effort extraction over strict verbatim matching.'

  const user = [
    { type: 'text', text: `Language hint: ${String(languageHint || 'unknown')}` },
    { type: 'image_url', image_url: { url: dataUrl } },
  ]

  try {
    const model = resolveModel()
    const aiCall = await callOpenAiWithRetry({
      requestId,
      tag: 'vision',
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    if (!aiCall.ok) {
      if (aiCall.status === 'timeout') return { error: 'ai_timeout', detail: aiCall.detail }
      const code = typeof aiCall.status === 'number' ? `ai_call_failed_${aiCall.status}` : 'ai_exception'
      return { error: code, detail: aiCall.detail }
    }
    const data = aiCall.data
    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParseJson(content)
    if (!parsed || typeof parsed !== 'object') return { error: 'ai_invalid_response' }

    return { fields: parsed }
  } catch {
    return { error: 'ai_exception' }
  }
}

async function extractFieldsFromTextWithAIOnly(text, languageHint, requestId) {
  if (!isAiOcrEnabled()) return { error: 'ai_disabled' }
  const input = String(text || '').trim()
  if (!input) return { error: 'empty_text' }

  const system =
    'You are a document understanding assistant for invoices and payment slips. Return JSON ONLY with this schema: ' +
    '{"supplier": string|null, "creditor_name": string|null, "payer_name": string|null, "invoice_number": string|null, "amount": number|null, "currency": string|null, "due_date": string|null, "iban": string|null, "reference": string|null, "purpose": string|null, "item_name": string|null}. ' +
    'Rules: ' +
    '- Use best-effort extraction from the text (may normalize spacing/case). ' +
    '- issuer/supplier must be a clean company name only (no labels, no addresses, no emails, no URLs). ' +
    '- due_date must be in YYYY-MM-DD if present. ' +
    '- amount must be numeric and currency 3-letter code (e.g., EUR). ' +
    '- If uncertain, return null.'

  const user =
    'Language hint: ' + String(languageHint || 'unknown') + '\n' +
    'Document text:\n' + input.slice(0, 12000)

  try {
    const model = resolveModel()
    const aiCall = await callOpenAiWithRetry({
      requestId,
      tag: 'text',
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 420,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    if (!aiCall.ok) {
      if (aiCall.status === 'timeout') return { error: 'ai_timeout', detail: aiCall.detail }
      const code = typeof aiCall.status === 'number' ? `ai_call_failed_${aiCall.status}` : 'ai_exception'
      return { error: code, detail: aiCall.detail }
    }
    const data = aiCall.data
    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParseJson(content)
    if (!parsed || typeof parsed !== 'object') return { error: 'ai_invalid_response' }
    return { fields: parsed }
  } catch {
    return { error: 'ai_exception' }
  }
}

function jsonResponse(statusCode, payload) {
  const base = payload && typeof payload === 'object' ? { ...payload } : { ok: false }
  const isError = Boolean(base.error) || base.ok === false
  if (isError && !('status' in base)) base.status = statusCode
  if (isError && !('detail' in base)) base.detail = null
  const requestId = base.requestId || (typeof globalThis !== 'undefined' ? globalThis.__ocrRequestId : null)
  if (requestId) base.requestId = requestId
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(base),
  }
}

async function enhanceImageBase64IfPossible(base64Image) {
  // Optional dependency: keep tests/lightweight environments working without native modules.
  let sharp
  try {
    const mod = await import('sharp')
    sharp = mod?.default || mod
  } catch {
    return null
  }
  try {
    const input = Buffer.from(String(base64Image || ''), 'base64')
    if (!input || input.length < 16) return null
    const outBuf = await sharp(input)
      .rotate() // auto-orient
      .resize({ width: 2000, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer()
    return outBuf && outBuf.length ? outBuf.toString('base64') : null
  } catch {
    return null
  }
}

async function visionAnnotateImage({ accessToken, base64Image, timeoutMs = 15000 }) {
  const payload = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'TEXT_DETECTION' },
          { type: 'BARCODE_DETECTION' },
        ],
        imageContext: {
          // Helps OCR when the bill is Slovenian/English/German/Italian.
          languageHints: ['sl', 'en', 'de', 'it'],
        },
      },
    ],
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const statusText = resp.statusText || ''
      throw new Error(`vision_call_failed status ${resp.status} ${statusText}`.trim())
    }
    return await resp.json()
  } finally {
    clearTimeout(timeout)
  }
}

function safeDetailFromError(err) {
  try {
    const msg = (err && err.message) || 'vision_api_error'
    const s = String(msg).replace(/\n/g, ' ').replace(/private_key/gi, 'redacted')
    return s.length > 400 ? s.slice(0, 400) : s
  } catch {
    return 'vision_api_error'
  }
}

function bufferToBase64(buf) {
  if (typeof buf === 'string') return buf
  return Buffer.from(buf).toString('base64')
}

function bodyToBuffer(event) {
  if (event.isBase64Encoded) return Buffer.from(event.body || '', 'base64')
  if (Buffer.isBuffer(event.body)) return event.body
  return Buffer.from(event.body || '')
}

function getContentType(event) {
  const h = event?.headers || {}
  return String(h['content-type'] || h['Content-Type'] || '').toLowerCase()
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

async function getUserFromAuthHeader(event) {
  const header = event.headers.authorization || event.headers.Authorization || ''
  if (!header || typeof header !== 'string') return { userId: null, error: 'missing_authorization' }
  const parts = header.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    return { userId: null, error: 'invalid_authorization' }
  }
  const token = parts[1]
  const supabase = getSupabaseAdmin()
  if (!supabase) return { userId: null, error: 'supabase_admin_not_configured' }
  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user?.id) return { userId: null, error: 'invalid_token' }
    return { userId: data.user.id, error: null, supabase }
  } catch (e) {
    return { userId: null, error: safeDetailFromError(e) }
  }
}

function isSameMonth(a, b) {
  if (!a || !b) return false
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
}

async function parsePdfText(pdfBuffer) {
  // Important: do NOT import `pdf-parse` package root here.
  // The package entrypoint contains a CLI/test block that can misbehave under bundlers.
  const mod = await import('pdf-parse/lib/pdf-parse.js')
  const pdfParse = mod?.default || mod
  const parsed = await pdfParse(pdfBuffer)
  const text = (parsed?.text || '').trim()
  const numpages = typeof parsed?.numpages === 'number' && Number.isFinite(parsed.numpages) && parsed.numpages > 0 ? parsed.numpages : null
  return { text, numpages }
}

function buildPageBatches(totalPages, batchSize = 5) {
  const n = typeof totalPages === 'number' && Number.isFinite(totalPages) && totalPages > 0 ? Math.floor(totalPages) : 0
  if (!n) return [[1, 2]]
  const pages = []
  for (let i = 1; i <= n; i++) pages.push(i)
  const batches = []
  for (let i = 0; i < pages.length; i += batchSize) batches.push(pages.slice(i, i + batchSize))
  return batches.length ? batches : [[1]]
}

async function visionAnnotatePdf({ accessToken, pdfBuffer, pages, timeoutMs = 20000 }) {
  // Google Vision supports PDF OCR via files:annotate.
  // This is critical for scanned PDFs where pdf-parse yields no text.
  const base64Pdf = Buffer.from(pdfBuffer || '').toString('base64')
  if (!base64Pdf || base64Pdf.length < 32) throw new Error('empty_pdf')
  const requestedPages = Array.isArray(pages) && pages.length ? pages : [1]

  const payload = {
    requests: [
      {
        inputConfig: { content: base64Pdf, mimeType: 'application/pdf' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        pages: requestedPages,
        imageContext: { languageHints: ['sl', 'en', 'de', 'it'] },
      },
    ],
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch('https://vision.googleapis.com/v1/files:annotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const statusText = resp.statusText || ''
      throw new Error(`vision_files_annotate_failed status ${resp.status} ${statusText}`.trim())
    }
    const raw = await resp.json().catch(() => null)
    const pages = raw?.responses?.[0]?.responses
    if (!Array.isArray(pages) || pages.length === 0) return ''
    const parts = []
    for (const p of pages) {
      const t = p?.fullTextAnnotation?.text || p?.textAnnotations?.[0]?.description || ''
      const s = String(t || '').trim()
      if (s) parts.push(s)
    }
    return parts.join('\n\n').trim()
  } finally {
    clearTimeout(timeout)
  }
}

async function visionAnnotatePdfAllPages({ accessToken, pdfBuffer, numpages, timeoutMs = 25000 }) {
  const batches = buildPageBatches(numpages, 5)
  const parts = []
  let scannedPages = 0
  for (const batch of batches) {
    const t = await visionAnnotatePdf({ accessToken, pdfBuffer, pages: batch, timeoutMs })
    if (t) parts.push(t)
    scannedPages += Array.isArray(batch) ? batch.length : 0
  }
  return { text: parts.join('\n\n').trim(), scannedPages: scannedPages || null, requestedPages: batches.flat() }
}

function extractFields(rawText) {
  const text = (rawText || '').replace(/\r/g, '')
  const out = { supplier: null, creditor_name: null, invoice_number: null, amount: null, currency: null, due_date: null, iban: null, reference: null, reference_model: null, reference_number: null, purpose: null, payment_details: null, item_name: null }

  function isPayerLine(line) {
    return /\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b\s*:?/i.test(String(line || ''))
  }

  function parseMoneyAmount(input) {
    const raw = String(input || '').trim()
    if (!raw) return null
    // Keep only digits, separators and an optional leading minus.
    const cleaned = raw.replace(/[^0-9.,\-\s]/g, '').trim()
    if (!/[0-9]/.test(cleaned)) return null
    const s = cleaned.replace(/\s+/g, '')

    const lastComma = s.lastIndexOf(',')
    const lastDot = s.lastIndexOf('.')
    let decimalSep = null
    if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.'
    else if (lastComma >= 0) decimalSep = ','
    else if (lastDot >= 0) decimalSep = '.'

    let normalized = s
    if (decimalSep === ',') {
      // 1.234,56 -> 1234.56
      normalized = s.replace(/\./g, '').replace(',', '.')
    } else if (decimalSep === '.') {
      // 1,234.56 -> 1234.56
      normalized = s.replace(/,/g, '')
    }
    // Keep only a single leading '-'
    normalized = normalized.replace(/(?!^)-/g, '')
    const num = Number(normalized)
    return Number.isFinite(num) ? num : null
  }

  function hasLetters(s) {
    return /[A-Za-zÀ-žČŠŽčšž]/.test(String(s || ''))
  }

  function isLikelyNoiseLine(line) {
    const s = String(line || '').trim()
    if (!s) return true
    const compact = s.replace(/\s+/g, '')
    // Pure numbers / punctuation
    if (/^[0-9\s.,:\-\/]+$/.test(s)) return true
    // IBAN
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(compact)) return true
    // Amount snippets
    if (/^EUR\s*\d/i.test(s)) return true
    // Dates
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true
    if (/^\d{2}[\.\/]\d{2}[\.\/]\d{2,4}$/.test(s)) return true
    return false
  }

  function digitsToLettersRatio(s) {
    const str = String(s || '')
    const digits = (str.match(/\d/g) || []).length
    const letters = (str.match(/[A-Za-zÀ-žČŠŽčšž]/g) || []).length
    return { digits, letters }
  }

  function isLikelyDocumentHeader(s) {
    const t = String(s || '').trim()
    if (!t) return true
    // Very common headers that are not a supplier name.
    if (/\b(ra\u010dun|invoice|faktura|opomin|dobavnica|ponudba|predra\u010dun|storno|obvestilo)\b/i.test(t)) return true
    if (/\b(za\s*pla\S*|rok\s*pla\S*|zapad|znesek|sklic|namen|iban|prejemnik|pla\u010dnik|payer|payee|recipient)\b/i.test(t)) return true
    return false
  }

  function isLikelyServicePeriodLine(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    if (!t) return false
    const monthSl = /(januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december)\s+20\d{2}/i
    const monthEn = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}/i
    const service = /(elektri\S*\s*energija|electric\S*\s*energy|electricity|power\b|plin\b|gas\b|heating|ogrevanj\S*)/i
    return service.test(t) && (monthSl.test(t) || monthEn.test(t))
  }

  function isLikelyAddressLine(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    if (!t) return false
    // Street/address keywords + a number, or a postal code-like token.
    if (/\b(ulica|cesta|street|st\.?|road|rd\.?|avenue|ave\.?|strasse|stra\u00dfe|via|trg|naselje|posta|po\u0161t\S*|zip)\b/i.test(t) && /\d{1,4}\b/.test(t)) return true
    if (/\b\d{4}\b/.test(t) && /\b(ljubljana|maribor|celje|koper|kranj|novo\s*mesto|ptuj|murska\s*sobota)\b/i.test(t)) return true
    return false
  }

  function looksLikePersonNameLine(name) {
    const t = String(name || '').replace(/\s+/g, ' ').trim()
    if (!t) return false
    if (/[0-9]/.test(t)) return false
    if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(t)) return false
    const parts = t.split(' ').filter(Boolean)
    if (parts.length < 2 || parts.length > 3) return false
    const cap = (w) => /^[A-ZČŠŽ][a-zà-žčšž]+$/.test(w)
    return parts.every(cap) && t.length <= 32
  }

  function pickSupplierHeuristic(lines) {
    const all = Array.isArray(lines) ? lines : []
    let best = null
    let bestScore = -1

    const supplierLabelRe = /\b(dobavitelj|supplier|vendor|seller|issuer|bill\s*from|izdajatelj(?:\s+ra\u010duna)?|prodajalec|izdal)\b/i

    for (let i = 0; i < all.length; i++) {
      const s = String(all[i] || '').trim()
      if (!s) continue
      if (!hasLetters(s)) continue
      if (isLikelyServicePeriodLine(s)) continue
      if (isLikelyAddressLine(s)) continue
      if (/\bheader\b/i.test(s)) continue
      if (looksLikeMisassignedName(s)) continue
      if (isLikelyNoiseLine(s)) continue
      if (isPayerLine(s)) continue
      if (isLikelyDocumentHeader(s)) continue
      if (looksLikePersonNameLine(s)) continue

      // Skip label lines themselves.
      if (supplierLabelRe.test(s)) continue

      // Guard against accidentally picking payment identifiers.
      const compact = s.replace(/\s+/g, '')
      if (/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/.test(compact)) continue // IBAN-like
      if (/\b(?:SI|RF)\d{2}\b/i.test(compact)) continue // reference-ish

      const { digits, letters } = digitsToLettersRatio(s)
      if (letters === 0) continue
      if (digits >= 8 && digits > letters) continue
      if (s.length < 3 || s.length > 70) continue

      let score = 0
      // Prefer earlier lines a bit, but allow anywhere.
      score += Math.max(0, 6 - Math.floor(i / 12))
      // Prefer company markers.
      if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(s)) score += 5
      // Short-ish lines are more likely names.
      if (s.length >= 4 && s.length <= 50) score += 2
      // Many letters vs digits.
      if (letters >= 8 && digits <= 2) score += 3

      // Boost if adjacent to a supplier label line.
      const prev = String(all[i - 1] || '')
      const next = String(all[i + 1] || '')
      if (supplierLabelRe.test(prev) || supplierLabelRe.test(next)) score += 6

      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }

    return bestScore >= 4 ? best : null
  }

  // Supplier: pick a line that actually looks like a name (letters), not a random number/header.
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (lines.length) {
    // Prefer explicit labels (works better internationally).
    const supplierLabel = /^(?:dobavitelj|supplier|vendor|seller|issuer|bill\s*from)\b\s*[:#\-]\s*(.+)$/i
    let labeledSupplier = null
    for (const l of lines) {
      if (isPayerLine(l)) continue
      const m = String(l).match(supplierLabel)
      if (!m) continue
      const v = String(m[1] || '').trim()
      if (!v) continue
      if (hasLetters(v) && !looksLikeMisassignedName(v) && !looksLikePersonNameLine(v) && v.length >= 2) {
        labeledSupplier = v
        break
      }
    }

    // Supplier name is required for accounting. Prefer labeled supplier, otherwise use a conservative heuristic.
    out.supplier = labeledSupplier && !looksLikeMisassignedName(labeledSupplier)
      ? labeledSupplier
      : pickSupplierHeuristic(lines)
  }

  // IBAN
  try {
    const ibanCandidates = []
    const ibanRe = /\b[A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,34}\b/g
    for (const line of text.toUpperCase().split(/\n+/)) {
      const matches = line.match(ibanRe)
      if (!matches) continue
      for (const m of matches) {
        const normalized = normalizeIban(m)
        if (normalized) ibanCandidates.push(normalized)
      }
    }
    if (ibanCandidates.length) out.iban = ibanCandidates[0]
  } catch {}

  // Amount + currency
  try {
    const currencyFromSymbol = (s) => {
      if (/€/.test(s)) return 'EUR'
      if (/[£]/.test(s)) return 'GBP'
      if (/[¥]/.test(s)) return 'JPY'
      if (/\$/.test(s)) return 'USD'
      return null
    }

    const payableLabels = /(total\s*due|amount\s*due|balance\s*due|grand\s*total|za\s*pla\S*|za\s*pla\u010dat\S*|za\s*pla\u010dilo|za\s*pla\u010dati|payable|to\s*pay|pay\s*now)/i
    const totalLabels = /(grand\s*total|\btotal\b|\bskupaj\b)/i
    const ignoreContext = /(\bddv\b|\bvat\b|\btax\b|\bdavek\b|osnova|base\s*amount|\bsubtotal\b|sub\s*total|popust|discount|provizi\S*|fee\b|shipping|po\u0161tnina|delivery|surcharge)/i

    const labelBoostForLine = (line) => {
      const l = String(line || '')
      const hasPayable = payableLabels.test(l)
      const hasTotal = totalLabels.test(l)
      const hasIgnore = ignoreContext.test(l)
      // Ignore VAT/subtotal lines unless explicitly payable.
      if (hasIgnore && !hasPayable) return 0
      if (hasPayable) return 6
      if (hasTotal) return 4
      return 0
    }

    const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
    const candidates = []

    const pushFromLine = (line, labelBoost) => {
      const sym = currencyFromSymbol(line)
      const codePrefix = line.match(/\b([A-Z]{3})\b\s*([0-9][0-9.,\s-]{0,20})/i)
      if (codePrefix) {
        const cur = String(codePrefix[1]).toUpperCase()
        const val = parseMoneyAmount(codePrefix[2])
        if (val != null) candidates.push({ currency: cur, amount: val, score: 2 + labelBoost })
      }
      const codeSuffix = line.match(/([0-9][0-9.,\s-]{0,20})\s*\b([A-Z]{3})\b/i)
      if (codeSuffix) {
        const cur = String(codeSuffix[2]).toUpperCase()
        const val = parseMoneyAmount(codeSuffix[1])
        if (val != null) candidates.push({ currency: cur, amount: val, score: 2 + labelBoost })
      }
      if (sym) {
        const m = line.match(/([0-9][0-9.,\s-]{0,20})\s*[$€£¥]/)
        if (m) {
          const val = parseMoneyAmount(m[1])
          if (val != null) candidates.push({ currency: sym, amount: val, score: 1 + labelBoost })
        }
      }
    }

    for (const l of lines) {
      const boost = labelBoostForLine(l)
      if (boost <= 0) continue
      pushFromLine(l, boost)
    }
    // Fallback: search whole text for prefix/suffix codes.
    if (!candidates.length) {
      const all = text.match(/\b[A-Z]{3}\b\s*[0-9][0-9.,\s-]{0,20}|[0-9][0-9.,\s-]{0,20}\s*\b[A-Z]{3}\b/g) || []
      for (const chunk of all) pushFromLine(chunk, 0)
    }

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score)
      // Reliability: accept only strong payable/total lines.
      const bestPayable = candidates.find((c) => c.score >= 8) // 2 + payableBoost(6)
      const bestTotal = candidates.find((c) => c.score >= 6) // 2 + totalBoost(4)
      const best = bestPayable || bestTotal || null
      if (best) {
        out.currency = best.currency
        out.amount = best.amount
      }
    }
  } catch {}

  // Due date: prefer labeled due dates; avoid picking random issue dates.
  try {
    // NOTE: don't use \w here; it doesn't match diacritics (e.g. "plačila").
    const dueLabel = /(rok\s*pla[^\s:]*|zapad[^\s:]*|due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by|f[äa]llig[^\s:]*|zahlbar\s*bis|scadenza|scad\.?\b|[ée]ch[ée]ance|vencim\S*|vencimiento)/i
    const dateToken = /(\d{4}[-\/]\d{2}[-\/]\d{2}|\d{1,2}[\.\/-]\d{1,2}[\.\/-]\d{2,4})/

    const dueLabelEnglish = /(due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by)/i

    let picked = null
    let hintEnglish = false
    const inline = text.match(new RegExp(`${dueLabel.source}\\s*:?\\s*${dateToken.source}`, 'i'))
    if (inline) {
      picked = inline[2]
      hintEnglish = dueLabelEnglish.test(inline[1] || '')
    }

    if (!picked) {
      for (let i = 0; i < lines.length - 1; i++) {
        const l = lines[i]
        if (!dueLabel.test(l)) continue
        hintEnglish = dueLabelEnglish.test(l)
        const next = lines[i + 1]
        const m = next && String(next).match(dateToken)
        if (m) { picked = m[1]; break }
      }
    }

    if (!picked) {
      const all = [...new Set((text.match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{2}[\.\/]\d{2}[\.\/]\d{2,4}\b/g) || []).map((d) => String(d).trim()))]
      if (all.length === 1) picked = all[0]
    }

    if (picked) out.due_date = parseDateToken(picked, hintEnglish)
  } catch {}

  // Reference / sklic (avoid confusing IBAN lines for SIxx references)
  try {
    const modeled = extractModelAndReference(text)
    if (modeled?.model && modeled?.number) {
      const full = `${modeled.model.replace(/\s+/g, '')}${modeled.number}`
      out.reference = full
      out.reference_model = modeled.model
      out.reference_number = modeled.number
    }
    let refVal = null
    for (const l of lines) {
      const labeled = l.match(/\b(sklic|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
      if (!labeled) continue
      const v = String(labeled[2] || '').trim()
      if (!v) continue
      const m = v.match(/\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/i)
      refVal = m ? m[1] : v
      const compact = String(refVal || '').replace(/\s+/g, '').toUpperCase()
      if (isValidIbanChecksum(compact)) { refVal = null; continue }
      break
    }
    if (!refVal) {
      for (const l of lines) {
        const m = l.match(/\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/i)
        if (!m) continue
        const compact = String(m[1] || '').replace(/\s+/g, '').toUpperCase()
        if (isValidIbanChecksum(compact)) continue
        refVal = m[1]
        break
      }
    }
    // Extra pass for split-box layouts: SI / model / number separated by whitespace/newlines.
    if (!refVal) {
      const m = text.match(/\b(SI\s*\d{2}\s*(?:[0-9A-Z\-\/]\s*){4,}|RF\s*\d{2}\s*(?:[0-9A-Z\-\/]\s*){4,})\b/i)
      if (m) {
        const compact = String(m[1] || '').replace(/\s+/g, '').toUpperCase()
        if (!isValidIbanChecksum(compact)) refVal = m[1]
      }
    }
    if (refVal) out.reference = String(refVal).replace(/\s+/g, '')
  } catch {}

  // Purpose / memo / description
  // 1) Labeled extraction first (deterministic)
  try {
    const purp = text.match(/(?:namen(?:\s+pla\S*)?|opis(?:\s+pla\S*)?|purpose|memo|description|payment\s*for)\s*:?\s*(.+)/i)
    if (purp) out.purpose = String(purp[1] || '').trim()
  } catch {}

  // 2) Unlabeled fallback (evidence-based): find a line that looks like service + billing period.
  // This is intentionally narrow to avoid “hallucinating” a purpose.
  if (!out.purpose) {
    try {
      const monthSl = /(januar|februar|marec|april|maj|junij|julij|avgust|september|oktober|november|december)\s+20\d{2}/i
      const monthEn = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}/i
      const service = /(elektri\S*\s*energija|electric\S*\s*energy|electricity|power\b|plin\b|gas\b|heating|ogrevanj\S*)/i
      const ignore = /(iban|trr|sklic|referenca|rok\s*pla\S*|zapade|znesek|ddv|vat|subtotal|grand\s*total|\btotal\b)/i
      const lines2 = String(text || '').split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)

      let best = null
      let bestScore = -1
      for (let i = 0; i < lines2.length; i++) {
        const l = lines2[i]
        if (!l || l.length < 6 || l.length > 90) continue
        if (ignore.test(l)) continue

        const hasSvc = service.test(l)
        const hasPeriod = monthSl.test(l) || monthEn.test(l)

        let candidate = l
        if ((!hasSvc || !hasPeriod) && lines2[i + 1] && (lines2[i + 1].length <= 60)) {
          const combo = `${l} – ${lines2[i + 1]}`
          if (!ignore.test(combo) && service.test(combo) && (monthSl.test(combo) || monthEn.test(combo))) candidate = combo
        }

        const c = String(candidate || '').replace(/\s+/g, ' ').trim()
        if (!c || c.length < 6 || c.length > 90) continue
        if (ignore.test(c)) continue

        let score = 0
        if (service.test(c)) score += 3
        if (monthSl.test(c) || monthEn.test(c)) score += 3
        if (score > bestScore) { bestScore = score; best = c }
      }

      if (bestScore >= 6 && best) out.purpose = best
    } catch {}
  }

  // Item / purchase subject (non-payment): labeled product/service name or a meaningful description.
  if (!out.item_name) {
    try {
      const item = extractItemNameFromText(rawText)
      if (item) out.item_name = item
    } catch {}
  }

  // Creditor/payee name (often same as supplier)
  const cred = text.match(/(prejemnik|recipient|payee|beneficiary|creditor|to\s*:|upravi[^\s:]*)\s*:?\s*(.+)/i)
  if (cred) {
    const v = String(cred[2] || '').trim()
    if (v && !isPayerLine(v) && /[A-Za-zÀ-žČŠŽčšž]/.test(v) && v.length >= 2 && !looksLikeMisassignedName(v)) out.creditor_name = v
  }

  // If not explicitly labeled, try to infer the payee name from the context around the IBAN.
  // This helps when PDFs/images contain the payment instruction block without a clear label.
  if (!out.creditor_name && out.iban) {
    try {
      const iban = normalizeIban(out.iban)
      const idx = lines.findIndex((l) => {
        const compact = String(l || '').toUpperCase().replace(/\s+/g, '')
        return iban && compact.includes(iban)
      })
      if (idx >= 0) {
        let best = null
        let bestScore = -1
        for (let j = Math.max(0, idx - 4); j <= Math.min(lines.length - 1, idx + 4); j++) {
          const s = String(lines[j] || '').trim()
          if (!s) continue
          if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) continue
          if (isPayerLine(s)) continue
          if (looksLikeMisassignedName(s)) continue
          if (isLikelyNoiseLine(s)) continue
          if (isLikelyDocumentHeader(s)) continue
          if (isLikelyServicePeriodLine(s)) continue
          if (isLikelyAddressLine(s)) continue
          if (/\biban\b/i.test(s)) continue
          let score = 0
          // Prefer lines close to the IBAN line, especially above it.
          const dist = Math.abs(j - idx)
          score += (4 - Math.min(4, dist))
          if (j < idx) score += 1
          // Prefer company markers.
          if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(s)) score += 2
          if (s.length >= 4 && s.length <= 50) score += 1
          if (score > bestScore) { bestScore = score; best = s }
        }
        if (bestScore >= 3 && best && !looksLikeMisassignedName(best)) out.creditor_name = best
      }
    } catch {}
  }

  // For this app, supplier and payee are the same entity; if only one is present, keep it.
  if (!out.creditor_name && out.supplier) out.creditor_name = out.supplier

  // Invoice number / document number (safe field; do not use AI when disabled)
  try {
    const looksLikeInvoiceId = (s) => {
      const v = String(s || '').trim()
      if (!v) return false
      if (v.length < 3 || v.length > 32) return false
      if (!/\d/.test(v)) return false
      const compact = v.toUpperCase().replace(/\s+/g, '')
      if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(compact)) return false // IBAN
      if (/^SI\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return false // usually reference
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false // date
      return true
    }

    const invLabel = /(ra\u010dun|faktura|invoice|document|dokument|\bno\b|number|\bšt\b|st\.|št\.|stevilka|\bref\b|reference)/i

    // Inline pattern: "Račun št: 2026-001", "Invoice No: INV-1001" etc.
    const inline = text.match(/(ra\u010dun|faktura|invoice|dokument|document)\s*(št\.|st\.|no\.?|nr\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/\.]{2,})/i)
    if (inline && looksLikeInvoiceId(inline[3])) out.invoice_number = String(inline[3]).trim()

    // Next-line pattern: label line followed by id.
    if (!out.invoice_number) {
      for (let i = 0; i < lines.length - 1; i++) {
        const l = String(lines[i] || '').trim()
        if (!invLabel.test(l)) continue
        if (!/[:#]?$/.test(l) && !/(ra\u010dun|invoice|faktura|dokument|document)/i.test(l)) continue
        const nxt = String(lines[i + 1] || '').trim()
        const token = (nxt.match(/[A-Z0-9][A-Z0-9\-\/\.]{2,}/i) || [])[0]
        if (token && looksLikeInvoiceId(token)) {
          out.invoice_number = token.trim()
          break
        }
      }
    }

    // Purpose-based pattern: many Slovenian QR/payment slips put invoice id/period into Namen.
    if (!out.invoice_number) {
      for (const l of lines) {
        if (!/\b(namen|purpose|opis|description|memo|payment\s*for)\b/i.test(l)) continue
        const after = (l.split(/:\s*/, 2)[1] || '').trim()
        const tokens = (after.match(/[A-Z0-9][A-Z0-9\-\/\.]{2,}/gi) || []).slice(0, 6)
        for (const tok of tokens) {
          if (looksLikeInvoiceId(tok)) { out.invoice_number = String(tok).trim(); break }
        }
        if (out.invoice_number) break
      }
    }
  } catch {}



  // Payment details (non-IBAN systems): collect labeled lines verbatim-ish from OCR.
  // This is displayed as notes and can be used when IBAN/reference are not applicable (e.g. USA/UK/AU).
  try {
    const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
    const keyLine = /(SWIFT|BIC|ROUTING|ABA|SORT\s*CODE|BSB|ACCOUNT\s*(NO\.?|NUMBER)?|A\/?C\b|BENEFICIARY|PAYEE|BANK\s*DETAILS|BANK\s*NAME|WIRE\b)/i
    const picked = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!keyLine.test(l)) continue
      picked.push(l)
      // If it's a label-only line, also grab the next line.
      if ((/[:\-]$/.test(l) || l.length <= 18) && lines[i + 1]) {
        const n = lines[i + 1]
        if (n && n.length <= 120) picked.push(n)
      }
    }

    // Also capture common labeled numeric identifiers when present.
    const more = []
    const routing = text.match(/(ROUTING\s*(NUMBER|NO\.?|#)?\s*[:\-]?\s*)(\d{9})/i)
    if (routing) more.push(`Routing: ${routing[3]}`)
    const sort = text.match(/(SORT\s*CODE\s*[:\-]?\s*)(\d{2}[-\s]?\d{2}[-\s]?\d{2})/i)
    if (sort) more.push(`Sort code: ${sort[2].replace(/\s+/g, '')}`)
    const bsb = text.match(/(\bBSB\b\s*[:\-]?\s*)(\d{3}[-\s]?\d{3})/i)
    if (bsb) more.push(`BSB: ${bsb[2].replace(/\s+/g, '')}`)
    const acct = text.match(/(ACCOUNT\s*(NUMBER|NO\.?|#)\s*[:\-]?\s*)([0-9]{6,20})/i)
    if (acct) more.push(`Account: ${acct[3]}`)
    const swift = text.match(/(SWIFT|BIC)\s*[:\-]?\s*([A-Z0-9]{8}(?:[A-Z0-9]{3})?)/i)
    if (swift) more.push(`${swift[1].toUpperCase()}: ${swift[2].toUpperCase()}`)

    const merged = [...picked, ...more]
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .filter((s) => s.length <= 180)

    // Dedupe
    const uniq = []
    const seen = new Set()
    for (const s of merged) {
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      uniq.push(s)
    }

    if (uniq.length) out.payment_details = uniq.slice(0, 8).join('\n')
  } catch {}

  return out
}

async function extractFieldsWithAI(rawText, candidates, languageHint, requestId) {
  if (!isAiOcrEnabled()) return { error: 'ai_disabled' }
  const text = String(rawText || '').trim()
  if (!text) return { error: 'empty_text' }

  const flatten = (list, max = 8) =>
    (Array.isArray(list) ? list : [])
      .filter((c) => c && c.value)
      .slice(0, max)
      .map((c) => ({ value: c.value, evidence: c.evidence || String(c.value || '') }))

  const candidatePayload = {
    issuer_name: flatten(candidates?.supplier),
    payer_name: flatten(candidates?.payer_name),
    invoice_number: flatten(candidates?.invoice_number),
    amount: flatten(candidates?.amount),
    currency: flatten(candidates?.amount),
    due_date: flatten(candidates?.due_date),
    iban: flatten(candidates?.iban),
    reference: flatten(candidates?.reference),
    purpose: flatten(candidates?.purpose),
    item_name: flatten(candidates?.item_name),
  }

  const system =
    'You are a document understanding assistant. Return JSON ONLY with this schema: ' +
    '{"issuer_name": string|null, "payer_name": string|null, "invoice_number": string|null, "amount": number|null, "currency": string|null, "due_date": string|null, "iban": string|null, "reference": string|null, "purpose": string|null, "item_name": string|null}. ' +
    'Rules: ' +
    '- Values MUST exist verbatim in OCR text. If not found confidently, return null. ' +
    '- Candidates below are hints; you may select any exact substring from the OCR text. ' +
    '- issuer_name must be a clean company name only (no labels, emails, URLs). ' +
    '- purpose should be a short description of goods/services if present; otherwise null. ' +
    '- item_name is the purchase subject (product/service name) if present; otherwise null. ' +
    '- Never fabricate values.'

  const user =
    'Language hint: ' + String(languageHint || 'unknown') + '\n' +
    'OCR text (may be messy):\n' +
    text.slice(0, 6000) +
    '\n\nCandidates:\n' +
    JSON.stringify(candidatePayload, null, 2)

  try {
    const model = resolveModel()
    const aiCall = await callOpenAiWithRetry({
      requestId,
      tag: 'doc',
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 320,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    if (!aiCall.ok) {
      if (aiCall.status === 'timeout') return { error: 'ai_timeout', detail: aiCall.detail }
      const code = typeof aiCall.status === 'number' ? `ai_call_failed_${aiCall.status}` : 'ai_exception'
      return { error: code, detail: aiCall.detail }
    }
    const data = aiCall.data
    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParseJson(content)
    if (!parsed || typeof parsed !== 'object') return { error: 'ai_invalid_response' }

    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const normalizeForSearch = (s) => normalize(s).toUpperCase()
    const appearsInText = (value) => {
      const v = normalizeForSearch(value)
      if (!v) return false
      const t = normalizeForSearch(text)
      return Boolean(t && v && t.includes(v))
    }
    const matchCandidate = (value, list) => {
      const v = normalize(value)
      if (!v) return null
      const options = Array.isArray(list) ? list : []
      for (const c of options) {
        const candidate = normalize(c?.value)
        if (candidate && candidate.toUpperCase() === v.toUpperCase()) return candidate
      }
      return null
    }
    const matchCandidateOrText = (value, list) => matchCandidate(value, list) || (appearsInText(value) ? normalize(value) : null)

    const matchAmount = (amount, currency, list) => {
      const amt = typeof amount === 'number' ? amount : null
      const cur = typeof currency === 'string' ? currency.toUpperCase() : null
      if (!amt || !cur) return null
      const options = Array.isArray(list) ? list : []
      for (const c of options) {
        const cand = c?.value
        if (!cand || typeof cand.amount !== 'number' || typeof cand.currency !== 'string') continue
        if (Math.abs(cand.amount - amt) < 0.005 && String(cand.currency).toUpperCase() === cur) return { amount: cand.amount, currency: cur }
      }
      return null
    }

    const issuer = matchCandidateOrText(parsed.issuer_name, candidatePayload.issuer_name)
    const payer = matchCandidateOrText(parsed.payer_name, candidatePayload.payer_name)
    const invoice = matchCandidateOrText(parsed.invoice_number, candidatePayload.invoice_number)
    const due = matchCandidate(parsed.due_date, candidatePayload.due_date)
    const iban = matchCandidate(parsed.iban, candidatePayload.iban)
    const reference = matchCandidate(parsed.reference, candidatePayload.reference)
    const purpose = matchCandidateOrText(parsed.purpose, candidatePayload.purpose)
    const itemName = matchCandidateOrText(parsed.item_name, candidatePayload.item_name)
    const amt = matchAmount(parsed.amount, parsed.currency, candidatePayload.amount)

    const out = {
      supplier: issuer || null,
      creditor_name: issuer || null,
      payer_name: payer || null,
      invoice_number: invoice || null,
      amount: amt ? amt.amount : null,
      currency: amt ? amt.currency : null,
      due_date: due || null,
      iban: iban || null,
      reference: reference || null,
      purpose: purpose || null,
      item_name: itemName || null,
    }

    if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.due_date)) out.due_date = null
    if (out.currency && !/^[A-Z]{3}$/.test(out.currency)) out.currency = null
    if (out.iban) {
      const iban = normalizeIban(out.iban)
      if (!isValidIbanChecksum(iban)) out.iban = null
      else out.iban = iban
    }

    return { fields: out }
  } catch {
    return { error: 'ai_exception' }
  }
}

function mergeFields(base, ai, rawText) {
  const out = { ...base }
  if (!ai) return sanitizeFields(rawText, out)

  const aiFields = ai?.fields && typeof ai.fields === 'object' ? ai.fields : ai

  const containsNorm = (hay, needle) => {
    const h = String(hay || '').toUpperCase().replace(/\s+/g, ' ').trim()
    const n = String(needle || '').toUpperCase().replace(/\s+/g, ' ').trim()
    if (!h || !n) return false
    return h.includes(n)
  }

  const looksLikePersonName = (name) => {
    const t = String(name || '').replace(/\s+/g, ' ').trim()
    if (!t) return false
    if (/[0-9]/.test(t)) return false
    if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(t)) return false
    const parts = t.split(' ').filter(Boolean)
    if (parts.length < 2 || parts.length > 3) return false
    const cap = (w) => /^[A-ZČŠŽ][a-zà-žčšž]+$/.test(w)
    return parts.every(cap) && t.length <= 32
  }

  const appearsOnPayerLine = (text, value) => {
    const v = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim()
    if (!v) return false
    const lines = String(text || '').replace(/\r/g, '').split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
    for (const l of lines) {
      if (!/\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b/i.test(l)) continue
      const ln = l.toUpperCase().replace(/\s+/g, ' ')
      if (ln.includes(v)) return true
    }
    return false
  }

  const appearsOnLabeledLine = (text, value, labelRe) => {
    const v = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim()
    if (!v) return false
    const lines = String(text || '').replace(/\r/g, '').split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
    for (const l of lines) {
      if (!labelRe.test(l)) continue
      const ln = l.toUpperCase().replace(/\s+/g, ' ')
      if (ln.includes(v)) return true
    }
    return false
  }

  const appearsInTopLines = (text, value, maxLines = 12) => {
    const v = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim()
    if (!v) return false
    const lines = String(text || '').replace(/\r/g, '').split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
    const top = lines.slice(0, Math.max(1, maxLines))
    for (const l of top) {
      const ln = l.toUpperCase().replace(/\s+/g, ' ')
      if (ln.includes(v)) return true
    }
    return false
  }

  const supplierLabelRe = /\b(dobavitelj|supplier|vendor|seller|issuer|bill\s*from|izdajatelj(?:\s+ra\u010duna)?|prodajalec|izdal)\b/i
  const creditorLabelRe = /\b(prejemnik|recipient|payee|beneficiary|creditor|upravi\S*|to)\b/i
  const headerIssuer = extractIssuerFromHeaderBlock(rawText)
  const normalizeNameCandidate = (s) => normalizeCompanyNameCandidate(s) || String(s || '').replace(/\s+/g, ' ').trim()
  const headerMatch = (name) => {
    const h = normalizeNameCandidate(headerIssuer)
    const n = normalizeNameCandidate(name)
    if (!h || !n) return false
    return h.toUpperCase() === n.toUpperCase()
  }

  // AI is allowed to help with non-payment-critical fields.
  // Also allow AI to override clearly misassigned heuristic names.
  if (
    (out.supplier == null || looksLikeMisassignedName(out.supplier)) &&
    aiFields.supplier &&
    !looksLikeMisassignedName(aiFields.supplier) &&
    containsNorm(rawText, aiFields.supplier) &&
    (appearsOnLabeledLine(rawText, aiFields.supplier, supplierLabelRe) || headerMatch(aiFields.supplier) || (appearsInTopLines(rawText, aiFields.supplier, 12) && hasLegalSuffix(aiFields.supplier))) &&
    !/\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b/i.test(String(aiFields.supplier || '')) &&
    !appearsOnPayerLine(rawText, aiFields.supplier) &&
    !looksLikePersonName(aiFields.supplier)
  ) {
    out.supplier = aiFields.supplier
  }
  if (
    (out.creditor_name == null || looksLikeMisassignedName(out.creditor_name)) &&
    aiFields.creditor_name &&
    !looksLikeMisassignedName(aiFields.creditor_name) &&
    containsNorm(rawText, aiFields.creditor_name) &&
    (appearsOnLabeledLine(rawText, aiFields.creditor_name, creditorLabelRe) || headerMatch(aiFields.creditor_name) || (appearsInTopLines(rawText, aiFields.creditor_name, 12) && hasLegalSuffix(aiFields.creditor_name))) &&
    !/\b(pla\u010dnik|placnik|payer|kupec|buyer|customer)\b/i.test(String(aiFields.creditor_name || '')) &&
    !appearsOnPayerLine(rawText, aiFields.creditor_name) &&
    !looksLikePersonName(aiFields.creditor_name)
  ) {
    out.creditor_name = aiFields.creditor_name
  }
  if (!out.invoice_number && aiFields.invoice_number && containsNorm(rawText, aiFields.invoice_number)) out.invoice_number = aiFields.invoice_number
  if (!out.purpose && aiFields.purpose && containsNorm(rawText, aiFields.purpose)) out.purpose = aiFields.purpose
  if (!out.item_name && aiFields.item_name && containsNorm(rawText, aiFields.item_name)) out.item_name = aiFields.item_name

  if (out.amount == null && typeof aiFields.amount === 'number' && Number.isFinite(aiFields.amount)) {
    out.amount = aiFields.amount
  }
  if (!out.currency && aiFields.currency && /^[A-Z]{3}$/.test(String(aiFields.currency))) out.currency = aiFields.currency
  if (!out.due_date && aiFields.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(aiFields.due_date))) out.due_date = aiFields.due_date
  // Do not take AI-proposed payment details; too easy to hallucinate/misread.

  // Payment-critical: only fill if base is missing AND the value is verifiable.
  // IBAN is chosen from OCR text via sanitizeFields (AI may misread digits).
  if (!out.reference && aiFields.reference) {
    const r = String(aiFields.reference || '').replace(/\s+/g, '').toUpperCase()
    const compact = String(rawText || '').toUpperCase()
    const allRefs = [...new Set((compact.match(/SI\d{2}\s*[0-9A-Z\-\/]{4,}/g) || []).map((x) => String(x || '').replace(/\s+/g, '').toUpperCase()))]
    if (textContainsReference(rawText, r) || allRefs.length === 1) out.reference = r
  }
  if (out.currency == null && aiFields.currency && /^[A-Z]{3}$/.test(String(aiFields.currency))) out.currency = aiFields.currency
  // Do not take AI-proposed amounts. OCR amounts must be text-evidenced (handled in extractFields + sanitizeFields).

  return sanitizeFields(rawText, out)
}

// Deterministic EPC/UPN QR parsing (bank-style): if we can decode a QR payload, do not OCR-guess.
function normalizeQrText(input) {
  const s = (input ?? '').toString()
  let out = s.replace(/\u001d/g, '\n').replace(/\r/g, '\n')
  if (!out.includes('\n') && out.includes('|') && (/\bBCD\b/.test(out) || /UPNQR/i.test(out))) {
    out = out.replace(/\|/g, '\n')
  }
  return out
}

function normalizeReferenceSimple(input) {
  const s = String(input || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9\-\/]/g, '')
  return s || undefined
}

function parseEPC_QR(text) {
  try {
    const lines = normalizeQrText(text)
      .split(/\n/)
      .map((l) => l.trim())
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    if (lines.length < 7) return null
    if (lines[0] !== 'BCD') return null
    const serviceTag = lines[3]
    if (serviceTag !== 'SCT') return null
    const name = lines[5] || ''
    const ibanRaw = normalizeIban(lines[6] || '')
    const iban = ibanRaw && isValidIbanChecksum(ibanRaw) ? ibanRaw : null
    const amountLine = lines[7] || ''
    let amount = null
    let currency = null
    if (amountLine.startsWith('EUR')) {
      const num = amountLine.slice(3)
      const parsed = Number(String(num).replace(',', '.'))
      if (!Number.isNaN(parsed) && parsed > 0) { amount = parsed; currency = 'EUR' }
    }
    const l8 = lines[8] || ''
    const nextLooksLikeReference = /\b(?:SI\d{2}|RF\d{2})\b/i.test(String(lines[9] || ''))
    const hasPurposeCode = /^[A-Z0-9]{4}$/.test(l8) || (nextLooksLikeReference && /^[A-Z0-9]{1,4}$/.test(l8))
    const remittance = (hasPurposeCode ? (lines[9] || '') : l8).trim()
    const info = (hasPurposeCode ? (lines[10] || '') : (lines[9] || '')).trim()
    const combined = [remittance, info].filter(Boolean).join('\n')
    const refMatch = combined.match(/(SI\d{2}\s*[0-9A-Z\-\/]{4,}|RF\d{2}[0-9A-Z]{4,})/i)
    const reference = refMatch ? String(refMatch[1] || '').replace(/\s+/g, '').toUpperCase() : null
    let purpose = combined
    if (reference && refMatch) {
      purpose = purpose.replace(refMatch[1], '').replace(/\s{2,}/g, ' ').trim()
    }
    // Do not re-introduce the reference into purpose.
    if (!purpose) purpose = ''
    return {
      iban: iban || null,
      creditor_name: name || null,
      amount,
      currency,
      purpose: purpose || null,
      reference: reference ? normalizeReferenceSimple(reference) : null,
    }
  } catch {
    return null
  }
}

function parseUPN_QR(text) {
  try {
    const normalized = normalizeQrText(text)
    const lines = normalized.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    const joined = lines.join('\n')
    if (!/UPNQR|UPN/i.test(joined) && !/SI\d{2}[A-Z0-9]{15,}/.test(joined)) return null

    const findValidIbanInText = (t) => {
      const matches = String(t || '').match(/\b[A-Z]{2}\d{2}(?:\s*[A-Z0-9]){11,34}\b/g) || []
      for (const m of matches) {
        const cand = normalizeIban(m)
        if (!cand) continue
        if (isValidIbanChecksum(cand)) return cand
      }
      return null
    }

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

    let amount = null
    let currency = null
    for (const l of lines) {
      const eurMatch = l.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
      if (eurMatch) {
        const val = Number(String(eurMatch[1]).replace(',', '.'))
        if (Number.isFinite(val) && val > 0) { amount = val; currency = 'EUR'; break }
      }
    }
    if (typeof amount !== 'number') {
      for (const l of lines) {
        if (/^\d{11}$/.test(l)) {
          const cents = Number(l)
          if (Number.isFinite(cents) && cents > 0) { amount = cents / 100; currency = 'EUR'; break }
        }
      }
    }

    let reference = null
    for (const l of lines) {
      const labeled = l.match(/\b(sklic|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
      if (!labeled) continue
      const cand = normalizeReferenceSimple(labeled[2])
      if (!cand) continue
      if (iban && cand === iban) continue
      reference = cand
      break
    }
    if (!reference) {
      for (const l of lines) {
        if (/\biban\b/i.test(l)) continue
        const m = l.match(/\bSI\d{2}\s*[0-9A-Z\-\/]{4,}\b/i)
        if (!m) continue
        const cand = normalizeReferenceSimple(m[0])
        if (!cand) continue
        if (iban && cand === iban) continue
        reference = cand
        break
      }
    }

    let purpose = null
    for (const l of lines) {
      const m = l.match(/(?:namen|purpose)\s*:?\s*(.+)$/i)
      if (m) {
        const v = String(m[1] || '').trim()
        if (v) { purpose = v; break }
      }
    }

    let creditor_name = null
    for (const l of lines) {
      const m = l.match(/(?:prejemnik|recipient|payee|upravi\w*|name)\s*:?\s*(.+)$/i)
      if (!m) continue
      const n = String(m[1] || '').trim()
      if (!n) continue
      if (/UPNQR|\bUPN\b/i.test(n)) continue
      creditor_name = n
      break
    }

    let due_date = null
    const dueLabel = /(rok\s*pla[^\s:]*|zapad[^\s:]*|due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by)/i
    const dateToken = /(\d{4}[-\/]\d{2}[-\/]\d{2}|\d{1,2}[\.\/-]\d{1,2}[\.\/-]\d{2,4})/
    for (let i = 0; i < lines.length; i++) {
      const l = String(lines[i] || '').trim()
      if (!l || !dueLabel.test(l)) continue
      const hintEnglish = /(due\s*date|date\s*due|payment\s*due|pay\s*by|payable\s*by)/i.test(l)
      const inline = l.match(dateToken)
      if (inline?.[1]) {
        const iso = parseDateToken(inline[1], hintEnglish)
        if (iso) { due_date = iso; break }
      } else {
        const next = String(lines[i + 1] || '').trim()
        const m = next.match(dateToken)
        if (m?.[1]) {
          const iso = parseDateToken(m[1], hintEnglish)
          if (iso) { due_date = iso; break }
        }
      }
    }

    const result = { iban: iban || null, amount, currency, purpose, reference, creditor_name }
    if (due_date) result.due_date = due_date
    if (result.iban || typeof result.amount === 'number') return result
    return null
  } catch {
    return null
  }
}

function parsePaymentQR_QR(text) {
  return parseEPC_QR(text) || parseUPN_QR(text)
}

export async function handler(event) {
  try {
    const requestId = makeRequestId()
    if (typeof globalThis !== 'undefined') globalThis.__ocrRequestId = requestId

    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const authInfo = await getUserFromAuthHeader(event)
    if (!authInfo.userId || !authInfo.supabase) {
      // Do not leak details about why auth failed to the client
      return jsonResponse(401, { ok: false, error: 'auth_required', message: 'Sign in to use OCR.' })
    }

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const contentType = getContentType(event)

    let allowAi = true
    let languageHint = null
    let usageCounted = false

    const isText = /^text\/plain\b/i.test(contentType)
    let isPdf = /application\/pdf/i.test(contentType)

    console.log('[OCR] Request:', { requestId, contentType })

    // Text-only path: AI extraction from pasted QR text or other text payloads.
    // This does NOT count against OCR quota because no OCR/vision work is performed.
    if (isText) {
      const buf = bodyToBuffer(event)
      const text = String(buf?.toString('utf8') || '').trim()
      if (!text) return jsonResponse(400, { ok: false, error: 'missing_text' })
      if (aiVisionOnly) {
        const aiResult = await extractFieldsFromTextWithAIOnly(text, languageHint, requestId)
        const aiError = aiResult && aiResult.error ? aiResult.error : null
        const aiDetail = aiResult && aiResult.detail ? aiResult.detail : null
        if (!aiResult?.fields) {
          console.error('[OCR] AI text failed:', { error: aiError, detail: aiDetail })
          return jsonResponse(500, { ok: false, error: 'ai_text_failed', detail: aiDetail || aiError || 'unknown' })
        }
        const fields = sanitizeFieldsAiOnly(aiResult.fields)
        const meta = { ...buildExtractionMeta(text, fields), ai: { enabled: isAiOcrEnabled(), attempted: true, error: aiError, detail: aiDetail } }
        return jsonResponse(200, { ok: true, rawText: text, fields, meta, ai: true, aiModel: resolveModel(), aiTier: 'text', mode: 'ai_text' })
      }

      const fields0 = extractFields(text)
      const candidates = buildFieldCandidates(text)
      const aiResult = allowAi ? await extractFieldsWithAI(text, candidates, languageHint, requestId) : null
      const aiFields = aiResult && aiResult.fields ? aiResult : null
      const aiError = aiResult && aiResult.error ? aiResult.error : null
      const fields = mergeFields(fields0, aiFields, text)
      const aiModel = aiFields ? resolveModel() : null
      const aiTier = aiFields ? 'document' : null
      const meta = { ...buildExtractionMeta(text, fields), ai: { enabled: isAiOcrEnabled(), attempted: Boolean(allowAi), error: aiError } }
      return jsonResponse(200, { ok: true, rawText: text, fields, meta, ai: !!aiFields, aiModel, aiTier, mode: 'text' })
    }

    let base64Image
    let pdfBuffer
    let imageContentType = null
    // preferQr: when true, we attempt to decode EPC/UPN payload from barcodes/QRs inside images/PDF text.
    // Mobile upload flow wants document OCR, so it will send preferQr=false.
    let preferQr = true
    if (isPdf) {
      pdfBuffer = bodyToBuffer(event)
      if (!pdfBuffer || pdfBuffer.length < 16) {
        return jsonResponse(400, { ok: false, error: 'empty_pdf' })
      }
    } else if (/^image\//i.test(contentType)) {
      // Netlify sends base64 string when isBase64Encoded=true
      if (event.isBase64Encoded) base64Image = event.body
      else base64Image = bufferToBase64(event.body)
    } else if (/application\/json/i.test(contentType)) {
      try {
        const body = JSON.parse(event.body || '{}')
        if (typeof body.preferQr === 'boolean') preferQr = body.preferQr
        if (typeof body.allowAi === 'boolean') allowAi = body.allowAi
        if (typeof body.language === 'string') languageHint = String(body.language || '').trim()
        if (typeof body.contentType === 'string') imageContentType = String(body.contentType || '').trim()
        const pdf = String(body.pdfBase64 || '')
        if (pdf) {
          // Allow mobile clients to send PDFs as base64 JSON to avoid flaky local URI uploads.
          const p = pdf.startsWith('data:') ? pdf.split(',')[1] : pdf
          pdfBuffer = Buffer.from(p, 'base64')
          isPdf = true
        } else {
          const s = String(body.imageBase64 || '')
          if (s.startsWith('data:image/')) base64Image = s.split(',')[1]
          else base64Image = s
        }
      } catch {
        return jsonResponse(400, { ok: false, error: 'invalid_json_body' })
      }
    } else {
      // attempt fallback: assume body is base64
      base64Image = event.isBase64Encoded ? event.body : bufferToBase64(event.body)
    }

    if (!isPdf && (!base64Image || String(base64Image).length < 16)) {
      return jsonResponse(400, { ok: false, error: 'empty_image' })
    }

    // Load entitlements and enforce plan / quota
    let ent
    let hasEntRow = false
    try {
      const { data, error } = await supabase
        .from('entitlements')
        .select('*')
        .eq('user_id', userId)
        .order('active_until', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        // Unexpected error; treat as free and block to avoid giving away OCR
        return jsonResponse(403, { ok: false, error: 'ocr_not_allowed', message: 'OCR not available on your plan.' })
      }

      hasEntRow = Boolean(data)
      ent = data || {
        plan: 'free',
        ocr_quota_monthly: null,
        ocr_used_this_month: 0,
        updated_at: null,
      }
    } catch {
      return jsonResponse(403, { ok: false, error: 'ocr_not_allowed', message: 'OCR not available on your plan.' })
    }

    const plan = String(ent.plan || 'free')

    const now = new Date()
    const updatedAt = ent.updated_at ? new Date(ent.updated_at) : null
    // Default quotas if not configured in DB
    const quota = typeof ent.ocr_quota_monthly === 'number'
      ? ent.ocr_quota_monthly
      : (plan === 'free' ? 3 : null)
    let used = typeof ent.ocr_used_this_month === 'number' ? ent.ocr_used_this_month : 0
    if (!isSameMonth(now, updatedAt)) used = 0

    if (quota !== null && used >= quota) {
      return jsonResponse(403, { ok: false, error: 'ocr_quota_exceeded', message: 'OCR monthly quota exceeded for your plan.' })
    }

    const aiVisionOnly = Boolean(allowAi && isAiOcrEnabled())

    // PDF path: try extracting selectable text; if missing, fall back to Vision PDF OCR.
    if (isPdf) {
      // Guard size (Vision requests and Netlify limits): keep PDFs modest.
      if (pdfBuffer && pdfBuffer.length > 12 * 1024 * 1024) {
        return jsonResponse(400, { ok: false, error: 'file_too_large', message: 'PDF too large for OCR.' })
      }

      let text = ''
      let pdfPages = null
      let forceVisionOcr = false
      let aiAttemptedOnPdfText = false
      let aiErrorOnPdfText = null
      let aiDetailOnPdfText = null
      try {
        const parsed = await parsePdfText(pdfBuffer)
        text = String(parsed?.text || '').trim()
        pdfPages = typeof parsed?.numpages === 'number' ? parsed.numpages : null
      } catch {
        text = ''
        pdfPages = null
      }

      // If we got text, optionally parse deterministically first (EPC/UPN payloads sometimes live as text).
      if (text) {
        // Increment usage (counts as OCR/document extraction)
        try {
          const newUsed = used + 1
          if (hasEntRow) {
            await supabase
              .from('entitlements')
              .update({ ocr_used_this_month: newUsed, updated_at: now.toISOString() })
              .eq('user_id', userId)
          } else {
            await supabase
              .from('entitlements')
              .upsert({
                user_id: userId,
                plan: 'free',
                payer_limit: 1,
                exports_enabled: false,
                ocr_quota_monthly: 3,
                ocr_used_this_month: newUsed,
                subscription_source: 'free',
                status: 'active',
                updated_at: now.toISOString(),
              }, { onConflict: 'user_id' })
          }
          usageCounted = true
        } catch {}

        if (preferQr) {
          const parsedQr = parsePaymentQR_QR(text)
          if (parsedQr) {
            console.log('[OCR] QR found:', true, { mode: 'qr_text' })
            return jsonResponse(200, { ok: true, rawText: text, fields: sanitizeFields(text, parsedQr), ai: false, aiModel: null, aiTier: null, mode: 'qr_text' })
          }
        }

        let aiAttempted = false
        let aiError = null
        let aiDetail = null
        if (aiVisionOnly) {
          console.log('[OCR] AI-first PDF text:', { mode: 'ai_pdf_text', ocrLength: text.length })
          aiAttempted = true
          const aiResult = await extractFieldsFromTextWithAIOnly(text, languageHint, requestId)
          aiError = aiResult && aiResult.error ? aiResult.error : null
          aiDetail = aiResult && aiResult.detail ? aiResult.detail : null
          aiAttemptedOnPdfText = true
          aiErrorOnPdfText = aiError
          aiDetailOnPdfText = aiDetail
          if (aiResult?.fields) {
            const fields = sanitizeFieldsAiOnly(aiResult.fields)
            const missing = getMissingKeyFields(fields)
            if (!missing.hasMissing) {
              const meta = { ...buildExtractionMeta(text, fields), scanned: { mode: 'pdf_text', pdf_pages: pdfPages || null, scanned_pages: pdfPages || null }, ai: { enabled: isAiOcrEnabled(), attempted: true, error: aiError, detail: aiDetail } }
              return jsonResponse(200, { ok: true, rawText: text, fields, meta, ai: true, aiModel: resolveModel(), aiTier: 'text', mode: 'ai_pdf_text' })
            }
            aiError = aiError || 'ai_missing_fields'
            aiDetail = aiDetail || `missing:${missing.missing.join(',')}`
            aiErrorOnPdfText = aiError
            aiDetailOnPdfText = aiDetail
            console.warn('[OCR] AI PDF text missing key fields; falling back to Vision OCR.', { requestId, missing: missing.missing })
            forceVisionOcr = true
          } else {
            console.error('[OCR] AI PDF text failed; falling back to Vision OCR.', { error: aiError, detail: aiDetail })
            forceVisionOcr = true
          }
        }

        if (!forceVisionOcr) {
          console.log('[OCR] QR found:', false, { mode: 'pdf_text', ocrLength: text.length })
          const fields0 = extractFields(text)
          const candidates = buildFieldCandidates(text)
          const allowAiFallback = Boolean(allowAi && !aiAttempted)
          const aiResult = allowAiFallback ? await extractFieldsWithAI(text, candidates, languageHint, requestId) : null
          const aiFields = aiResult && aiResult.fields ? aiResult : null
          const aiErrorFallback = aiResult && aiResult.error ? aiResult.error : null
          if (aiFields?.fields) {
            const keys = Object.keys(aiFields.fields).filter((k) => aiFields.fields[k] != null)
            console.log('[OCR] AI extracted fields:', keys)
          }
          const fields = mergeFields(fields0, aiFields, text)
          const meta = { ...buildExtractionMeta(text, fields), scanned: { mode: 'pdf_text', pdf_pages: pdfPages || null, scanned_pages: pdfPages || null }, ai: { enabled: isAiOcrEnabled(), attempted: Boolean(aiAttempted || allowAiFallback), error: aiAttempted ? aiError : aiErrorFallback, detail: aiAttempted ? aiDetail : null } }
          const aiModel = aiFields ? resolveModel() : null
          const aiTier = aiFields ? 'document' : null
          return jsonResponse(200, { ok: true, rawText: text, fields, meta, ai: !!aiFields, aiModel, aiTier, mode: 'pdf_text' })
        }
      }

      // Scanned PDF (or forced fallback): use Vision PDF OCR to get text, then AI-only parse (no rules).
      const rawCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
      if (!rawCreds || String(rawCreds).trim() === '') {
        return jsonResponse(500, { ok: false, step: 'env', error: 'missing_google_credentials_json' })
      }
      let credentials
      try { credentials = JSON.parse(rawCreds) } catch {
        return jsonResponse(500, { ok: false, step: 'parse', error: 'invalid_credentials_json' })
      }
      const required = ['private_key', 'client_email']
      const missing = required.filter(k => !credentials[k] || String(credentials[k]).trim() === '')
      if (missing.length) {
        return jsonResponse(500, { ok: false, step: 'validate', error: 'credentials_json_missing_fields' })
      }

      const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-vision'] })
      let accessToken
      try {
        const client = await auth.getClient()
        const t = await client.getAccessToken()
        accessToken = typeof t === 'string' ? t : (t && t.token) || null
      } catch (e) {
        return jsonResponse(500, { ok: false, step: 'token', error: 'failed_to_get_access_token', detail: safeDetailFromError(e) })
      }
      if (!accessToken) return jsonResponse(500, { ok: false, step: 'token', error: 'no_access_token' })

      let ocrText = ''
      let parsedPdf = { text: '', numpages: null }
      let visionInfo = { scannedPages: null }
      try {
        // Full-document scan: OCR all pages (in batches) so fields can be found anywhere.
        parsedPdf = await parsePdfText(pdfBuffer).catch(() => ({ text: '', numpages: null }))
        const all = await visionAnnotatePdfAllPages({ accessToken, pdfBuffer, numpages: parsedPdf?.numpages || null })
        ocrText = String(all?.text || '').trim()
        visionInfo = { scannedPages: all?.scannedPages || null }
      } catch (e) {
        return jsonResponse(500, { ok: false, step: 'vision', error: 'vision_pdf_call_failed', detail: safeDetailFromError(e) })
      }

      // Increment usage (counts as OCR/document extraction)
      if (!usageCounted) {
        try {
          const newUsed = used + 1
          if (hasEntRow) {
            await supabase
              .from('entitlements')
              .update({ ocr_used_this_month: newUsed, updated_at: now.toISOString() })
              .eq('user_id', userId)
          } else {
            await supabase
              .from('entitlements')
              .upsert({
                user_id: userId,
                plan: 'free',
                payer_limit: 1,
                exports_enabled: false,
                ocr_quota_monthly: 3,
                ocr_used_this_month: newUsed,
                subscription_source: 'free',
                status: 'active',
                updated_at: now.toISOString(),
              }, { onConflict: 'user_id' })
          }
          usageCounted = true
        } catch {}
      }

      let aiAttempted = Boolean(aiAttemptedOnPdfText)
      let aiError = aiErrorOnPdfText
      let aiDetail = aiDetailOnPdfText
      const aiVisionOnlyForScan = Boolean(aiVisionOnly && !aiAttemptedOnPdfText)
      if (aiVisionOnlyForScan) {
        console.log('[OCR] AI-first PDF scan:', { mode: 'ai_pdf_vision', ocrLength: ocrText.length })
        aiAttempted = true
        const aiResult = await extractFieldsFromTextWithAIOnly(ocrText, languageHint, requestId)
        aiError = aiResult && aiResult.error ? aiResult.error : null
        aiDetail = aiResult && aiResult.detail ? aiResult.detail : null
        if (aiResult?.fields) {
          const fields = sanitizeFieldsAiOnly(aiResult.fields)
          const missing = getMissingKeyFields(fields)
          if (!missing.hasMissing) {
            const meta = { ...buildExtractionMeta(ocrText, fields), scanned: { mode: 'pdf_vision', pdf_pages: parsedPdf?.numpages || null, scanned_pages: visionInfo?.scannedPages || null }, ai: { enabled: isAiOcrEnabled(), attempted: true, error: aiError, detail: aiDetail } }
            return jsonResponse(200, { ok: true, rawText: ocrText, fields, meta, ai: true, aiModel: resolveModel(), aiTier: 'text', mode: 'ai_pdf_vision' })
          }
          console.warn('[OCR] AI PDF vision missing key fields; falling back to rule-based.', { requestId, missing: missing.missing })
          aiError = aiError || 'ai_missing_fields'
          aiDetail = aiDetail || `missing:${missing.missing.join(',')}`
        } else {
          console.error('[OCR] AI PDF vision failed; falling back to rule-based.', { error: aiError, detail: aiDetail })
        }
      }

      console.log('[OCR] QR found:', false, { mode: 'pdf_vision', ocrLength: ocrText.length })
      const fields0 = extractFields(ocrText)
      const candidates = buildFieldCandidates(ocrText)
      const allowAiFallback = Boolean(allowAi && !aiAttempted)
      const aiResult = allowAiFallback ? await extractFieldsWithAI(ocrText, candidates, languageHint, requestId) : null
      const aiFields = aiResult && aiResult.fields ? aiResult : null
      const aiErrorFallback = aiResult && aiResult.error ? aiResult.error : null
      if (aiFields?.fields) {
        const keys = Object.keys(aiFields.fields).filter((k) => aiFields.fields[k] != null)
        console.log('[OCR] AI extracted fields:', keys)
      }
      const fields = mergeFields(fields0, aiFields, ocrText)
      const meta = { ...buildExtractionMeta(ocrText, fields), scanned: { mode: 'pdf_vision', pdf_pages: parsedPdf?.numpages || null, scanned_pages: visionInfo?.scannedPages || null }, ai: { enabled: isAiOcrEnabled(), attempted: Boolean(aiAttempted || allowAiFallback), error: aiAttempted ? aiError : aiErrorFallback, detail: aiAttempted ? aiDetail : null } }
      const aiModel = aiFields ? resolveModel() : null
      const aiTier = aiFields ? 'document' : null
      return jsonResponse(200, { ok: true, rawText: ocrText, fields, meta, ai: !!aiFields, aiModel, aiTier, mode: 'pdf_vision' })
    }

    // Image path: AI-vision-only extraction (cheapest + closest to chat behavior).
    let aiAttempted = false
    let aiError = null
    let aiDetail = null
    if (aiVisionOnly) {
      const effectiveContentType = imageContentType || contentType
      // Increment usage (counts as OCR/document extraction)
      try {
        const newUsed = used + 1
        if (hasEntRow) {
          await supabase
            .from('entitlements')
            .update({ ocr_used_this_month: newUsed, updated_at: now.toISOString() })
            .eq('user_id', userId)
        } else {
          await supabase
            .from('entitlements')
            .upsert({
              user_id: userId,
              plan: 'free',
              payer_limit: 1,
              exports_enabled: false,
              ocr_quota_monthly: 3,
              ocr_used_this_month: newUsed,
              subscription_source: 'free',
              status: 'active',
              updated_at: now.toISOString(),
            }, { onConflict: 'user_id' })
        }
        usageCounted = true
      } catch {}

      aiAttempted = true
      const aiResult = await extractFieldsFromImageWithAI({ base64Image, contentType: effectiveContentType, languageHint, requestId })
      aiError = aiResult && aiResult.error ? aiResult.error : null
      aiDetail = aiResult && aiResult.detail ? aiResult.detail : null
      const aiFields = aiResult && aiResult.fields ? aiResult.fields : null
      if (aiFields) {
        const fields = sanitizeFieldsAiOnly(aiFields)
        const missing = getMissingKeyFields(fields)
        if (!missing.hasMissing) {
          const meta = { ...buildExtractionMeta('', fields), ai: { enabled: isAiOcrEnabled(), attempted: true, error: aiError, detail: aiDetail } }
          return jsonResponse(200, { ok: true, rawText: '', fields, meta, ai: true, aiModel: resolveModel(), aiTier: 'vision', mode: 'ai_vision' })
        }
        aiError = aiError || 'ai_missing_fields'
        aiDetail = aiDetail || `missing:${missing.missing.join(',')}`
        console.warn('[OCR] AI vision missing key fields; falling back to Google OCR.', { requestId, missing: missing.missing })
      } else {
        console.error('[OCR] AI vision failed; falling back to Google OCR.', { error: aiError, detail: aiDetail })
      }
    }

    const rawCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    if (!rawCreds || String(rawCreds).trim() === '') {
      return jsonResponse(500, { ok: false, step: 'env', error: 'missing_google_credentials_json' })
    }

    let credentials
    try { credentials = JSON.parse(rawCreds) } catch {
      return jsonResponse(500, { ok: false, step: 'parse', error: 'invalid_credentials_json' })
    }

    const required = ['private_key', 'client_email']
    const missing = required.filter(k => !credentials[k] || String(credentials[k]).trim() === '')
    if (missing.length) {
      return jsonResponse(500, { ok: false, step: 'validate', error: 'credentials_json_missing_fields' })
    }

    // Auth
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-vision'] })
    let accessToken
    try {
      const client = await auth.getClient()
      const t = await client.getAccessToken()
      accessToken = typeof t === 'string' ? t : (t && t.token) || null
    } catch (e) {
      return jsonResponse(500, { ok: false, step: 'token', error: 'failed_to_get_access_token', detail: safeDetailFromError(e) })
    }
    if (!accessToken) return jsonResponse(500, { ok: false, step: 'token', error: 'no_access_token' })

    let raw
    let rawEnhanced
    try {
      // If preferQr=false, skip BARCODE_DETECTION (document OCR only).
      if (preferQr) {
        raw = await visionAnnotateImage({ accessToken, base64Image, timeoutMs: 15000 })
      } else {
        const payload = {
          requests: [
            {
              image: { content: base64Image },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'TEXT_DETECTION' }],
              imageContext: { languageHints: ['sl', 'en', 'de', 'it'] },
            },
          ],
        }
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15000)
        const resp = await fetch('https://vision.googleapis.com/v1/images:annotate', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (!resp.ok) {
          const statusText = resp.statusText || ''
          throw new Error(`vision_call_failed status ${resp.status} ${statusText}`.trim())
        }
        raw = await resp.json()
      }

      // If the image is blurry/low-contrast, try an enhanced version to improve QR detection and OCR.
      const first = raw?.responses?.[0]
      const firstText = first?.fullTextAnnotation?.text || first?.textAnnotations?.[0]?.description || ''
      const firstBarcodes = first?.barcodeAnnotations
      const seemsWeak = (!preferQr || !firstBarcodes || !Array.isArray(firstBarcodes) || firstBarcodes.length === 0) && String(firstText || '').trim().length < 80
      if (seemsWeak) {
        const enhanced = await enhanceImageBase64IfPossible(base64Image)
        if (enhanced) {
          if (preferQr) {
            rawEnhanced = await visionAnnotateImage({ accessToken, base64Image: enhanced, timeoutMs: 15000 })
          } else {
            const payload = {
              requests: [
                {
                  image: { content: enhanced },
                  features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'TEXT_DETECTION' }],
                  imageContext: { languageHints: ['sl', 'en', 'de', 'it'] },
                },
              ],
            }
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 15000)
            const resp = await fetch('https://vision.googleapis.com/v1/images:annotate', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal,
            })
            clearTimeout(timeout)
            if (resp.ok) rawEnhanced = await resp.json()
          }
        }
      }
    } catch (e) {
      return jsonResponse(500, { ok: false, step: 'vision', error: 'vision_call_failed', detail: safeDetailFromError(e) })
    }

    // Prefer enhanced result when it clearly yields more usable output.
    if (rawEnhanced) {
      const a0 = raw?.responses?.[0]
      const b0 = rawEnhanced?.responses?.[0]
      const aText = (a0?.fullTextAnnotation?.text || a0?.textAnnotations?.[0]?.description || '').trim()
      const bText = (b0?.fullTextAnnotation?.text || b0?.textAnnotations?.[0]?.description || '').trim()
      const aBar = Array.isArray(a0?.barcodeAnnotations) ? a0.barcodeAnnotations.length : 0
      const bBar = Array.isArray(b0?.barcodeAnnotations) ? b0.barcodeAnnotations.length : 0
      if (bBar > aBar || (bText.length >= 200 && bText.length > aText.length + 50)) {
        raw = rawEnhanced
      }
    }

    // If preferQr=true and QR/barcode is present, behave like bank apps: decode QR payload and parse deterministically.
    if (preferQr) {
      try {
        const barcodes = raw?.responses?.[0]?.barcodeAnnotations
        if (Array.isArray(barcodes) && barcodes.length) {
          const candidates = barcodes
            .map((b) => String(b?.rawValue || b?.displayValue || '').trim())
            .filter(Boolean)
          const qrText = candidates.find((t) => /\bBCD\b/.test(t) || /UPNQR/i.test(t)) || candidates[0]
          if (qrText) {
            const parsedQr = parsePaymentQR_QR(qrText)
            if (parsedQr) {
              console.log('[OCR] QR found:', true, { mode: 'qr_barcode' })
              // Increment OCR usage on success before returning
              try {
                const newUsed = used + 1
                if (hasEntRow) {
                  await supabase
                    .from('entitlements')
                    .update({ ocr_used_this_month: newUsed, updated_at: now.toISOString() })
                    .eq('user_id', userId)
                } else {
                  await supabase
                    .from('entitlements')
                    .upsert({
                      user_id: userId,
                      plan: 'free',
                      payer_limit: 1,
                      exports_enabled: false,
                      ocr_quota_monthly: 3,
                      ocr_used_this_month: newUsed,
                      subscription_source: 'free',
                      status: 'active',
                      updated_at: now.toISOString(),
                    }, { onConflict: 'user_id' })
                }
              } catch {}

              return jsonResponse(200, { ok: true, rawText: qrText, fields: sanitizeFields(qrText, parsedQr), ai: false, aiModel: null, aiTier: null, mode: 'qr_barcode' })
            }
          }
        }
      } catch {}
    }

    // Increment OCR usage on success before returning
    if (!usageCounted) {
      try {
        const newUsed = used + 1
        if (hasEntRow) {
          await supabase
            .from('entitlements')
            .update({ ocr_used_this_month: newUsed, updated_at: now.toISOString() })
            .eq('user_id', userId)
        } else {
          await supabase
            .from('entitlements')
            .upsert({
              user_id: userId,
              plan: 'free',
              payer_limit: 1,
              exports_enabled: false,
              ocr_quota_monthly: 3,
              ocr_used_this_month: newUsed,
              subscription_source: 'free',
              status: 'active',
              updated_at: now.toISOString(),
            }, { onConflict: 'user_id' })
        }
        usageCounted = true
      } catch {
        // If this fails, we still return success; usage may be slightly off but users are not blocked
      }
    }

    const annotation = raw?.responses?.[0]
    const fullText = annotation?.fullTextAnnotation?.text || annotation?.textAnnotations?.[0]?.description || ''
    const full = fullText || ''
    console.log('[OCR] QR found:', false, { mode: 'vision_text', ocrLength: full.length })
    const fields0 = extractFields(full)
    const candidates = buildFieldCandidates(full)
    const allowAiFallback = Boolean(allowAi && !aiAttempted)
    const aiResult = allowAiFallback ? await extractFieldsWithAI(full, candidates, languageHint, requestId) : null
    const aiFields = aiResult && aiResult.fields ? aiResult : null
    const aiErrorFallback = aiResult && aiResult.error ? aiResult.error : null
    if (aiFields?.fields) {
      const keys = Object.keys(aiFields.fields).filter((k) => aiFields.fields[k] != null)
      console.log('[OCR] AI extracted fields:', keys)
    }
    const fields = mergeFields(fields0, aiFields, full)
    const meta = { ...buildExtractionMeta(full, fields), ai: { enabled: isAiOcrEnabled(), attempted: Boolean(aiAttempted || allowAiFallback), error: aiAttempted ? aiError : aiErrorFallback, detail: aiAttempted ? aiDetail : null } }

    const aiModel = aiFields ? resolveModel() : null
    const aiTier = aiFields ? 'document' : null
    return jsonResponse(200, { ok: true, rawText: fullText || '', fields, meta, ai: !!aiFields, aiModel, aiTier, mode: 'vision_text' })
  } catch (err) {
    return jsonResponse(500, { ok: false, step: 'catch', error: 'unhandled_exception', detail: safeDetailFromError(err) })
  }
}

// Exported for unit tests (pure helpers; safe to import without invoking handler).
export { extractFields, sanitizeFields, parsePaymentQR_QR, buildFieldCandidates }
