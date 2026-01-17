import { GoogleAuth } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'

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

function normalizeIban(input) {
  return String(input || '').toUpperCase().replace(/\s+/g, '')
}

function isValidIbanChecksum(iban) {
  const s = normalizeIban(iban)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(s)) return false
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
  const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
  // Allow spaces inside the token so we can capture whole strings like:
  // "SI56 0292 1503 0596 1290" (IBAN) and then exclude it by checksum.
  const refTokenRe = /\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/gi

  const normalizeRef = (s) => {
    const upper = String(s || '').toUpperCase()
    const m = upper.match(/\b(SI\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,}|RF\d{2}(?:[ \t]*[0-9A-Z\-\/]){4,})\b/i)
    const picked = m ? m[1] : upper
    const compact = picked.replace(/\s+/g, '')
    // If it is actually an IBAN (checksum-valid), it must not be considered a payment reference.
    if (isValidIbanChecksum(compact)) return null
    // Keep only plausible references.
    if (/^SI\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return compact
    if (/^RF\d{2}[0-9A-Z\-\/]{4,}$/i.test(compact)) return compact
    return null
  }

  const out = []
  const seen = new Set()

  // Prefer explicitly labeled lines.
  for (const l of lines) {
    const labeled = l.match(/\b(sklic|reference|ref\.?|model)\b\s*:?\s*(.+)$/i)
    if (!labeled) continue
    const cand = normalizeRef(labeled[2])
    if (!cand) continue
    if (!seen.has(cand)) { seen.add(cand); out.push(cand) }
  }

  // Fallback: scan all text, but exclude IBANs.
  const matches = text.match(refTokenRe) || []
  for (const m of matches) {
    const cand = normalizeRef(m)
    if (!cand) continue
    if (!seen.has(cand)) { seen.add(cand); out.push(cand) }
  }
  return out
}

function extractLabeledAmountCandidates(rawText) {
  const text = String(rawText || '').replace(/\r/g, '')
  const lines = text.split(/\n+/).map((l) => String(l || '').trim()).filter(Boolean)
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

  for (const line of lines) {
    const score = labelScore(line)
    if (score <= 0) continue
    const codePrefix = line.match(/\b([A-Z]{3})\b\s*([0-9][0-9.,\s-]{0,20})/i)
    if (codePrefix) {
      const cur = String(codePrefix[1]).toUpperCase()
      const val = parseMoneyAmountLoose(codePrefix[2])
      if (val != null && val > 0) out.push({ currency: cur, amount: val, line, score })
      continue
    }
    const sym = currencyFromSymbol(line)
    if (sym) {
      const m = line.match(/([0-9][0-9.,\s-]{0,20})\s*[$€£¥]/)
      const val = m ? parseMoneyAmountLoose(m[1]) : null
      if (val != null && val > 0) out.push({ currency: sym, amount: val, line, score })
    }
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

  const any = Boolean(doubt.iban || doubt.reference || doubt.amount)
  return { any, doubt, candidates }
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

function sanitizeFields(rawText, fields) {
  const out = { ...fields }
  // IBAN: never guess. If multiple are present, only auto-pick a clearly best candidate.
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
  if (out.reference) {
    const r = String(out.reference || '').replace(/\s+/g, '').toUpperCase()
    // Keep conservative: must look like SI.. or be explicitly present in OCR text.
    if (!(r.startsWith('SI') && r.length >= 6) && !textContainsReference(rawText, r)) out.reference = null
    else out.reference = r
  }
  if (typeof out.amount === 'number') {
    if (!Number.isFinite(out.amount) || out.amount <= 0 || out.amount > 1000000) out.amount = null
  }
  // Amount without a currency is too error-prone in OCR; only keep when currency is present/evidenced.
  if (typeof out.amount === 'number' && !out.currency) {
    const t = String(rawText || '')
    if (/\bEUR\b/i.test(t) || /€/.test(t)) out.currency = 'EUR'
    else out.amount = null
  }
  if (out.currency && !/^[A-Z]{3}$/.test(String(out.currency))) out.currency = null
  if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(out.due_date))) out.due_date = null
  if (out.supplier && typeof out.supplier === 'string') {
    const s = out.supplier.trim()
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) out.supplier = null
    else out.supplier = s
  }
  if (out.creditor_name && typeof out.creditor_name === 'string') {
    const s = out.creditor_name.trim()
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) out.creditor_name = null
    else out.creditor_name = s
  }
  if (out.creditor_name && looksLikeMisassignedName(out.creditor_name)) out.creditor_name = null
  if (out.supplier && looksLikeMisassignedName(out.supplier)) out.supplier = null

  // App rule: supplier and payee are the same entity.
  // Prefer creditor_name if available (it tends to come from explicit "Prejemnik" labels).
  const sameName = out.creditor_name || out.supplier || null
  if (sameName) {
    out.creditor_name = sameName
    out.supplier = sameName
  }
  if (out.purpose && typeof out.purpose === 'string') out.purpose = out.purpose.trim() || null
  if (out.payment_details && typeof out.payment_details === 'string') {
    const s = out.payment_details.trim()
    out.payment_details = s ? (s.length > 1200 ? s.slice(0, 1200) : s) : null
  }
  return out
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
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
  return (parsed?.text || '').trim()
}

async function visionAnnotatePdf({ accessToken, pdfBuffer, timeoutMs = 20000 }) {
  // Google Vision supports PDF OCR via files:annotate.
  // This is critical for scanned PDFs where pdf-parse yields no text.
  const base64Pdf = Buffer.from(pdfBuffer || '').toString('base64')
  if (!base64Pdf || base64Pdf.length < 32) throw new Error('empty_pdf')
  const payload = {
    requests: [
      {
        inputConfig: { content: base64Pdf, mimeType: 'application/pdf' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        pages: [1, 2],
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

function extractFields(rawText) {
  const text = (rawText || '').replace(/\r/g, '')
  const out = { supplier: null, creditor_name: null, invoice_number: null, amount: null, currency: null, due_date: null, iban: null, reference: null, purpose: null, payment_details: null }

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

    // Heuristics:
    // - If one side > 12, it must be the day.
    // - If ambiguous (<=12 both), assume MM/DD for English labels when delimiter is '/', else DD/MM.
    const aIsDay = a > 12 && a <= 31
    const bIsDay = b > 12 && b <= 31

    let day
    let month
    if (aIsDay && !bIsDay) {
      day = a
      month = b
    } else if (bIsDay && !aIsDay) {
      // MM/DD
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

  function pickSupplierHeuristic(lines) {
    const head = Array.isArray(lines) ? lines.slice(0, 12) : []
    let best = null
    let bestScore = -1

    for (const l of head) {
      const s = String(l || '').trim()
      if (!s) continue
      if (!hasLetters(s)) continue
      if (looksLikeMisassignedName(s)) continue
      if (isLikelyNoiseLine(s)) continue
      if (isPayerLine(s)) continue
      if (isLikelyDocumentHeader(s)) continue

      // Guard against accidentally picking payment identifiers.
      const compact = s.replace(/\s+/g, '')
      if (/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/.test(compact)) continue // IBAN-like
      if (/\bSI\d{2}\b/i.test(compact)) continue // reference-ish

      const { digits, letters } = digitsToLettersRatio(s)
      if (letters === 0) continue
      if (digits >= 8 && digits > letters) continue
      if (s.length < 3 || s.length > 60) continue

      let score = 0
      // Legal entity suffixes / company markers.
      if (/\b(d\.o\.o\.|d\.d\.|s\.p\.|gmbh|ag|oy|ab|sas|sarl|s\.r\.l\.|llc|ltd|inc)\b/i.test(s)) score += 3
      // Short-ish lines are more likely names.
      if (s.length >= 4 && s.length <= 40) score += 2
      // Many letters vs digits.
      if (letters >= 6 && digits <= 2) score += 2

      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }

    // Only accept when confidence is decent.
    return bestScore >= 3 ? best : null
  }

  // Supplier: pick a line that actually looks like a name (letters), not a random number/header.
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (lines.length) {
    // Prefer explicit labels (works better internationally).
    const supplierLabel = /\b(dobavitelj|supplier|vendor|seller|issuer|bill\s*from|from)\b\s*:?\s*(.+)$/i
    let labeledSupplier = null
    for (const l of lines) {
      const m = String(l).match(supplierLabel)
      if (!m) continue
      const v = String(m[2] || '').trim()
      if (!v) continue
      if (hasLetters(v) && !looksLikeMisassignedName(v) && v.length >= 2) {
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
    if (refVal) out.reference = String(refVal).replace(/\s+/g, '')
  } catch {}

  // Purpose / memo / description (only when explicitly labeled)
  try {
    const purp = text.match(/(?:namen(?:\s+pla\S*)?|opis(?:\s+pla\S*)?|purpose|memo|description|payment\s*for)\s*:?\s*(.+)/i)
    if (purp) out.purpose = String(purp[1] || '').trim()
  } catch {}

  // Creditor/payee name (often same as supplier)
  const cred = text.match(/(prejemnik|recipient|payee|beneficiary|creditor|to\s*:|upravi[^\s:]*)\s*:?\s*(.+)/i)
  if (cred) {
    const v = String(cred[2] || '').trim()
    if (v && !isPayerLine(v) && /[A-Za-zÀ-žČŠŽčšž]/.test(v) && v.length >= 2 && !looksLikeMisassignedName(v)) out.creditor_name = v
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
    const inline = text.match(/(ra\u010dun|faktura|invoice|dokument|document)\s*(št\.|st\.|no\.|nr\.|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i)
    if (inline && looksLikeInvoiceId(inline[3])) out.invoice_number = String(inline[3]).trim()

    // Next-line pattern: label line followed by id.
    if (!out.invoice_number) {
      for (let i = 0; i < lines.length - 1; i++) {
        const l = String(lines[i] || '').trim()
        if (!invLabel.test(l)) continue
        if (!/[:#]?$/.test(l) && !/(ra\u010dun|invoice|faktura|dokument|document)/i.test(l)) continue
        const nxt = String(lines[i + 1] || '').trim()
        const token = (nxt.match(/[A-Z0-9][A-Z0-9\-\/]{2,}/i) || [])[0]
        if (token && looksLikeInvoiceId(token)) {
          out.invoice_number = token.trim()
          break
        }
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

async function extractFieldsWithAI(rawText) {
  if (!isAiOcrEnabled()) return null
  const text = String(rawText || '').trim()
  if (!text) return null

  const system =
    'You extract structured payment/invoice fields from OCR text for a bill-tracking app. ' +
    'Return JSON ONLY with schema: ' +
    '{"supplier": string|null, "creditor_name": string|null, "invoice_number": string|null, "amount": number|null, "currency": string|null, "due_date": string|null, "iban": string|null, "reference": string|null, "purpose": string|null, "payment_details": string|null}. ' +
    'Rules: ' +
    '- Do NOT guess. Use null if uncertain. ' +
    '- supplier and creditor_name must be clean names only (no dates, references, amounts, or “rok plačila” text). ' +
    '- Prefer extracting invoice_number when present (invoice no / račun št / dokument št). ' +
    '- supplier is the issuer/seller; creditor_name is the payee on the payment instruction (often same as supplier). ' +
    '- due_date must be ISO YYYY-MM-DD if present, else null. ' +
    '- currency must be 3-letter uppercase (e.g., EUR) if present. ' +
    '- iban should be compact (no spaces) if present. ' +
    '- amount should be numeric (e.g., 12.34). ' +
    '- If the payment system is non-IBAN (routing/SWIFT/account), put those instructions into payment_details as a short multiline string, else null.'

  const user =
    'OCR text (may be messy):\n' +
    text.slice(0, 8000)

  try {
    const model = resolveModel()
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    const data = await resp.json().catch(() => null)
    if (!resp.ok) return null
    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParseJson(content)
    if (!parsed || typeof parsed !== 'object') return null

    const out = {
      supplier: typeof parsed.supplier === 'string' ? parsed.supplier.trim() || null : null,
      creditor_name: typeof parsed.creditor_name === 'string' ? parsed.creditor_name.trim() || null : null,
      invoice_number: typeof parsed.invoice_number === 'string' ? parsed.invoice_number.trim() || null : null,
      amount: typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) ? parsed.amount : null,
      currency: typeof parsed.currency === 'string' ? parsed.currency.trim().toUpperCase() || null : null,
      due_date: typeof parsed.due_date === 'string' ? parsed.due_date.trim() || null : null,
      iban: typeof parsed.iban === 'string' ? parsed.iban.replace(/\s+/g, '').trim() || null : null,
      reference: typeof parsed.reference === 'string' ? parsed.reference.trim() || null : null,
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose.trim() || null : null,
      payment_details: typeof parsed.payment_details === 'string' ? parsed.payment_details.trim() || null : null,
    }

    if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.due_date)) out.due_date = null
    if (out.currency && !/^[A-Z]{3}$/.test(out.currency)) out.currency = null
    if (out.iban) {
      const iban = normalizeIban(out.iban)
      if (!isValidIbanChecksum(iban)) out.iban = null
      else out.iban = iban
    }

    return out
  } catch {
    return null
  }
}

function mergeFields(base, ai, rawText) {
  const out = { ...base }
  if (!ai) return sanitizeFields(rawText, out)

  const containsNorm = (hay, needle) => {
    const h = String(hay || '').toUpperCase().replace(/\s+/g, ' ').trim()
    const n = String(needle || '').toUpperCase().replace(/\s+/g, ' ').trim()
    if (!h || !n) return false
    return h.includes(n)
  }

  // AI is allowed to help with non-payment-critical fields.
  // Also allow AI to override clearly misassigned heuristic names.
  if ((out.supplier == null || looksLikeMisassignedName(out.supplier)) && ai.supplier && !looksLikeMisassignedName(ai.supplier) && containsNorm(rawText, ai.supplier)) {
    out.supplier = ai.supplier
  }
  if ((out.creditor_name == null || looksLikeMisassignedName(out.creditor_name)) && ai.creditor_name && !looksLikeMisassignedName(ai.creditor_name) && containsNorm(rawText, ai.creditor_name)) {
    out.creditor_name = ai.creditor_name
  }
  if (!out.invoice_number && ai.invoice_number && containsNorm(rawText, ai.invoice_number)) out.invoice_number = ai.invoice_number
  if (!out.purpose && ai.purpose && containsNorm(rawText, ai.purpose)) out.purpose = ai.purpose
  // Do not take AI-proposed due dates or payment details; too easy to hallucinate/misread.

  // Payment-critical: only fill if base is missing AND the value is verifiable.
  // IBAN is chosen from OCR text via sanitizeFields (AI may misread digits).
  if (!out.reference && ai.reference) {
    const r = String(ai.reference || '').replace(/\s+/g, '').toUpperCase()
    const compact = String(rawText || '').toUpperCase()
    const allRefs = [...new Set((compact.match(/SI\d{2}\s*[0-9A-Z\-\/]{4,}/g) || []).map((x) => String(x || '').replace(/\s+/g, '').toUpperCase()))]
    if (textContainsReference(rawText, r) || allRefs.length === 1) out.reference = r
  }
  if (out.currency == null && ai.currency && /^[A-Z]{3}$/.test(String(ai.currency))) out.currency = ai.currency
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
  const s = String(input || '').toUpperCase().replace(/\s+/g, '')
  return s || undefined
}

function parseEPC_QR(text) {
  try {
    const lines = normalizeQrText(text).split(/\n+/).map((l) => l.trim())
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
    const hasPurposeCode = /^[A-Z0-9]{4}$/.test(l8)
    const remittance = (hasPurposeCode ? (lines[9] || '') : l8).trim()
    const info = (hasPurposeCode ? (lines[10] || '') : (lines[9] || '')).trim()
    const combined = [remittance, info].filter(Boolean).join('\n')
    const refMatch = combined.match(/(SI\d{2}\s*[0-9A-Z\-\/]{4,}|RF\d{2}[0-9A-Z]{4,})/i)
    const reference = refMatch ? String(refMatch[1] || '').replace(/\s+/g, '').toUpperCase() : null
    let purpose = combined
    if (reference && refMatch) {
      purpose = purpose.replace(refMatch[1], '').replace(/\s{2,}/g, ' ').trim()
    }
    if (!purpose) purpose = combined
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

    const result = { iban: iban || null, amount, currency, purpose, reference, creditor_name }
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

    const isText = /^text\/plain\b/i.test(contentType)
    let isPdf = /application\/pdf/i.test(contentType)

    // Text-only path: AI extraction from pasted QR text or other text payloads.
    // This does NOT count against OCR quota because no OCR/vision work is performed.
    if (isText) {
      const buf = bodyToBuffer(event)
      const text = String(buf?.toString('utf8') || '').trim()
      if (!text) return jsonResponse(400, { ok: false, error: 'missing_text' })
      const fields0 = extractFields(text)
      const aiFields = await extractFieldsWithAI(text)
      const fields = mergeFields(fields0, aiFields, text)
      return jsonResponse(200, { ok: true, rawText: text, fields, ai: !!aiFields, mode: 'text' })
    }

    let base64Image
    let pdfBuffer
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

    // PDF path: try extracting selectable text; if missing, fall back to Vision PDF OCR.
    if (isPdf) {
      // Guard size (Vision requests and Netlify limits): keep PDFs modest.
      if (pdfBuffer && pdfBuffer.length > 12 * 1024 * 1024) {
        return jsonResponse(400, { ok: false, error: 'file_too_large', message: 'PDF too large for OCR.' })
      }

      let text = ''
      try {
        text = await parsePdfText(pdfBuffer)
      } catch {
        text = ''
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
        } catch {}

        if (preferQr) {
          const parsedQr = parsePaymentQR_QR(text)
          if (parsedQr) {
            return jsonResponse(200, { ok: true, rawText: text, fields: sanitizeFields(text, parsedQr), ai: false, mode: 'qr_text' })
          }
        }

        const fields0 = extractFields(text)
        const aiFields = await extractFieldsWithAI(text)
        const fields = mergeFields(fields0, aiFields, text)
        const meta = buildExtractionMeta(text, fields)
        return jsonResponse(200, { ok: true, rawText: text, fields, meta, ai: !!aiFields, mode: 'pdf_text' })
      }

      // Scanned PDF: use Vision PDF OCR on the first page.
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
      try {
        ocrText = await visionAnnotatePdf({ accessToken, pdfBuffer })
      } catch (e) {
        return jsonResponse(500, { ok: false, step: 'vision', error: 'vision_pdf_call_failed', detail: safeDetailFromError(e) })
      }

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
      } catch {}

      const fields0 = extractFields(ocrText)
      const aiFields = await extractFieldsWithAI(ocrText)
      const fields = mergeFields(fields0, aiFields, ocrText)
      const meta = buildExtractionMeta(ocrText, fields)
      return jsonResponse(200, { ok: true, rawText: ocrText, fields, meta, ai: !!aiFields, mode: 'pdf_vision' })
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

              return jsonResponse(200, { ok: true, rawText: qrText, fields: sanitizeFields(qrText, parsedQr), ai: false, mode: 'qr_barcode' })
            }
          }
        }
      } catch {}
    }

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
    } catch {
      // If this fails, we still return success; usage may be slightly off but users are not blocked
    }

    const annotation = raw?.responses?.[0]
    const fullText = annotation?.fullTextAnnotation?.text || annotation?.textAnnotations?.[0]?.description || ''
    const full = fullText || ''
    const fields0 = extractFields(full)
    const aiFields = await extractFieldsWithAI(full)
    const fields = mergeFields(fields0, aiFields, full)
    const meta = buildExtractionMeta(full, fields)

    return jsonResponse(200, { ok: true, rawText: fullText || '', fields, meta, ai: !!aiFields, mode: 'vision_text' })
  } catch (err) {
    return jsonResponse(500, { ok: false, step: 'catch', error: 'unhandled_exception', detail: safeDetailFromError(err) })
  }
}

// Exported for unit tests (pure helpers; safe to import without invoking handler).
export { extractFields, sanitizeFields }
