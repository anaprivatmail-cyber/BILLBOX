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
  const compact = String(rawText || '').toUpperCase()
  const found = compact.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/g) || []
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
  if (out.currency && !/^[A-Z]{3}$/.test(String(out.currency))) out.currency = null
  if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(out.due_date))) out.due_date = null
  if (out.supplier && typeof out.supplier === 'string') {
    const s = out.supplier.trim()
    if (!/[A-Za-zÀ-žČŠŽčšž]/.test(s)) out.supplier = null
    else out.supplier = s
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

function extractFields(rawText) {
  const text = (rawText || '').replace(/\r/g, '')
  const out = { supplier: null, creditor_name: null, invoice_number: null, amount: null, currency: null, due_date: null, iban: null, reference: null, purpose: null, payment_details: null }

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

  // Supplier: pick a line that actually looks like a name (letters), not a random number/header.
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (lines.length) {
    const candidate =
      lines.find((l) => hasLetters(l) && !isLikelyNoiseLine(l) && !looksLikeMisassignedName(l) && l.length >= 3) ||
      lines.find((l) => hasLetters(l) && !looksLikeMisassignedName(l) && l.length >= 3) ||
      lines[0]
    out.supplier = looksLikeMisassignedName(candidate) ? null : candidate
  }

  // IBAN
  const ibanMatch = text.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/)
  if (ibanMatch) out.iban = ibanMatch[0].replace(/\s+/g, '')

  // Amount + currency
  let currency = null
  let amount = null
  const eur = text.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
  if (eur) { currency = 'EUR'; amount = eur[1] }
  if (!amount) {
    // 12,34 EUR / 12.34 EUR
    const eurAfter = text.match(/([0-9]+(?:[\.,][0-9]{1,2})?)\s*EUR\b/i)
    if (eurAfter) { currency = 'EUR'; amount = eurAfter[1] }
  }
  if (!amount) {
    // 12,34€ / 12.34 €
    const euroSign = text.match(/([0-9]+(?:[\.,][0-9]{1,2})?)\s*€/) 
    if (euroSign) { currency = 'EUR'; amount = euroSign[1] }
  }
  if (!amount) {
    const anyAmt = text.match(/([0-9]+(?:[\.,][0-9]{1,2})?)\s*(EUR|USD|GBP)/i)
    if (anyAmt) { amount = anyAmt[1]; currency = anyAmt[2].toUpperCase() }
  }
  if (amount) {
    const num = Number(String(amount).replace(',', '.'))
    if (!Number.isNaN(num)) out.amount = num
  }
  if (currency) out.currency = currency

  // Due date
  const date1 = text.match(/(\d{4}-\d{2}-\d{2})/) // YYYY-MM-DD
  const date2 = text.match(/(\d{2}[\.\/]-?\d{2}[\.\/]\d{4})/) // DD.MM.YYYY or DD/MM/YYYY
  const date3 = text.match(/(\d{2}[\.\/]\d{2}[\.\/]\d{2,4})/)
  const date = (date1?.[1] || date2?.[1] || date3?.[1] || '').replace(/[\s]/g, '')
  if (date) {
    // normalize to YYYY-MM-DD if possible
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.due_date = date
    else if (/^\d{2}[\.\/]\d{2}[\.\/]\d{4}$/.test(date)) {
      const [d, m, y] = date.replace(/[\.\/]/g, '-').split('-')
      out.due_date = `${y}-${m}-${d}`
    }
  }

  // Reference / sklic
  const ref = text.match(/(SI\d{2}\s*[0-9A-Z\-\/]{4,}|sklic:?\s*([A-Z0-9\-\/]+))/i)
  if (ref) out.reference = (ref[1] || ref[2] || '').replace(/\s+/g, '')

  // Purpose / namen
  const purp = text.match(/namen:?\s*(.+)|purpose:?\s*(.+)/i)
  if (purp) out.purpose = (purp[1] || purp[2] || '').trim()

  // Creditor/payee name (often same as supplier)
  const cred = text.match(/(prejemnik|recipient|payee|upravi\w*):?\s*(.+)/i)
  if (cred) {
    const v = String(cred[2] || '').trim()
    if (v && /[A-Za-zÀ-žČŠŽčšž]/.test(v) && v.length >= 2 && !looksLikeMisassignedName(v)) out.creditor_name = v
  }
  if (!out.creditor_name && out.supplier && !looksLikeMisassignedName(out.supplier)) out.creditor_name = out.supplier

  // Invoice number / document number (safe field; AI also helps later)
  const inv = text.match(/(ra\u010dun\s*(št\.|st\.|stevilka)?|\binvoice\b\s*(no\.|number)?|\bšt\.?\s*ra\u010duna|\bdokument\b\s*(št\.|no\.)?)\s*[:#]?\s*([A-Z0-9\-\/]{3,})/i)
  if (inv) {
    const v = String(inv[4] || '').trim()
    if (v) out.invoice_number = v
  }

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

  // AI is allowed to help with non-payment-critical fields.
  // Also allow AI to override clearly misassigned heuristic names.
  if ((out.supplier == null || looksLikeMisassignedName(out.supplier)) && ai.supplier && !looksLikeMisassignedName(ai.supplier)) {
    out.supplier = ai.supplier
  }
  if ((out.creditor_name == null || looksLikeMisassignedName(out.creditor_name)) && ai.creditor_name && !looksLikeMisassignedName(ai.creditor_name)) {
    out.creditor_name = ai.creditor_name
  }
  if (!out.invoice_number && ai.invoice_number) out.invoice_number = ai.invoice_number
  if (!out.purpose && ai.purpose) out.purpose = ai.purpose
  if (!out.due_date && ai.due_date) out.due_date = ai.due_date
  if (!out.payment_details && ai.payment_details) out.payment_details = ai.payment_details

  // Payment-critical: only fill if base is missing AND the value is verifiable.
  // IBAN is chosen from OCR text via sanitizeFields (AI may misread digits).
  if (!out.reference && ai.reference) {
    const r = String(ai.reference || '').replace(/\s+/g, '').toUpperCase()
    const compact = String(rawText || '').toUpperCase()
    const allRefs = [...new Set((compact.match(/SI\d{2}\s*[0-9A-Z\-\/]{4,}/g) || []).map((x) => String(x || '').replace(/\s+/g, '').toUpperCase()))]
    if (textContainsReference(rawText, r) || allRefs.length === 1) out.reference = r
  }
  if (out.currency == null && ai.currency && /^[A-Z]{3}$/.test(String(ai.currency))) out.currency = ai.currency
  if (typeof out.amount !== 'number' && typeof ai.amount === 'number' && Number.isFinite(ai.amount) && ai.amount > 0) out.amount = ai.amount

  return sanitizeFields(rawText, out)
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
    const isPdf = /application\/pdf/i.test(contentType)

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
        const s = String(body.imageBase64 || '')
        if (s.startsWith('data:image/')) base64Image = s.split(',')[1]
        else base64Image = s
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

    // PDF path: try text extraction first (works for many accounting PDFs)
    if (isPdf) {
      try {
        const text = await parsePdfText(pdfBuffer)
        if (!text) {
          return jsonResponse(400, {
            ok: false,
            error: 'pdf_no_text',
            message: 'This PDF has no extractable text (likely scanned). Please take a photo or upload an image instead.',
          })
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

        const fields0 = extractFields(text)
        const aiFields = await extractFieldsWithAI(text)
        const fields = mergeFields(fields0, aiFields, text)
        return jsonResponse(200, { ok: true, rawText: text, fields, ai: !!aiFields })
      } catch (e) {
        return jsonResponse(500, { ok: false, error: 'pdf_parse_failed', detail: safeDetailFromError(e) })
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

    const payload = {
      requests: [
        {
          image: { content: base64Image },
          features: [
            { type: 'DOCUMENT_TEXT_DETECTION' },
            { type: 'TEXT_DETECTION' }
          ]
        }
      ]
    }

    let raw
    try {
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
        return jsonResponse(500, { ok: false, step: 'vision', error: 'vision_call_failed', detail: `status ${resp.status} ${statusText}`.trim() })
      }
      raw = await resp.json()
    } catch (e) {
      return jsonResponse(500, { ok: false, step: 'vision', error: 'vision_call_failed', detail: safeDetailFromError(e) })
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

    return jsonResponse(200, { ok: true, rawText: fullText || '', fields, ai: !!aiFields })
  } catch (err) {
    return jsonResponse(500, { ok: false, step: 'catch', error: 'unhandled_exception', detail: safeDetailFromError(err) })
  }
}
