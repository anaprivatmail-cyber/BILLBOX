import { GoogleAuth } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

function resolveModel() {
  const raw = process.env.OPENAI_MODEL
  const model = typeof raw === 'string' ? raw.trim() : ''
  return model || 'gpt-4.1-mini'
}

function isAiOcrEnabled() {
  const flag = process.env.ENABLE_OCR_AI
  return String(flag || '').toLowerCase() === 'true' && !!OPENAI_API_KEY
}

function safeParseJson(s) {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
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
  const out = { supplier: null, amount: null, currency: null, due_date: null, iban: null, reference: null, purpose: null }

  // Supplier: first non-empty line candidate
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (lines.length) out.supplier = lines[0]

  // IBAN
  const ibanMatch = text.match(/[A-Z]{2}\d{2}[A-Z0-9]{11,34}/)
  if (ibanMatch) out.iban = ibanMatch[0].replace(/\s+/g, '')

  // Amount + currency
  let currency = null
  let amount = null
  const eur = text.match(/EUR\s*([0-9]+(?:[\.,][0-9]{1,2})?)/i)
  if (eur) { currency = 'EUR'; amount = eur[1] }
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
  const ref = text.match(/(SI\d{2}[0-9]{4,}|sklic:?\s*([A-Z0-9\-\/]+))/i)
  if (ref) out.reference = (ref[1] || ref[2] || '').replace(/\s+/g, '')

  // Purpose / namen
  const purp = text.match(/namen:?\s*(.+)|purpose:?\s*(.+)/i)
  if (purp) out.purpose = (purp[1] || purp[2] || '').trim()

  return out
}

async function extractFieldsWithAI(rawText) {
  if (!isAiOcrEnabled()) return null
  const text = String(rawText || '').trim()
  if (!text) return null

  const system =
    'You extract structured payment/invoice fields from OCR text for a bill-tracking app. ' +
    'Return JSON ONLY with schema: ' +
    '{"supplier": string|null, "amount": number|null, "currency": string|null, "due_date": string|null, "iban": string|null, "reference": string|null, "purpose": string|null}. ' +
    'Rules: ' +
    '- Do NOT guess. Use null if uncertain. ' +
    '- due_date must be ISO YYYY-MM-DD if present, else null. ' +
    '- currency must be 3-letter uppercase (e.g., EUR) if present. ' +
    '- iban should be compact (no spaces) if present. ' +
    '- amount should be numeric (e.g., 12.34).'

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
      amount: typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) ? parsed.amount : null,
      currency: typeof parsed.currency === 'string' ? parsed.currency.trim().toUpperCase() || null : null,
      due_date: typeof parsed.due_date === 'string' ? parsed.due_date.trim() || null : null,
      iban: typeof parsed.iban === 'string' ? parsed.iban.replace(/\s+/g, '').trim() || null : null,
      reference: typeof parsed.reference === 'string' ? parsed.reference.trim() || null : null,
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose.trim() || null : null,
    }

    if (out.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.due_date)) out.due_date = null
    if (out.currency && !/^[A-Z]{3}$/.test(out.currency)) out.currency = null
    if (out.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,34}$/.test(out.iban)) out.iban = null

    return out
  } catch {
    return null
  }
}

function mergeFields(base, override) {
  const out = { ...base }
  if (!override) return out
  for (const k of Object.keys(out)) {
    if (override[k] !== null && override[k] !== undefined && override[k] !== '') out[k] = override[k]
  }
  return out
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

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || ''

    const isPdf = /application\/pdf/i.test(contentType)

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
        const fields = mergeFields(fields0, aiFields)
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
    const fields0 = extractFields(fullText || '')
    const aiFields = await extractFieldsWithAI(fullText || '')
    const fields = mergeFields(fields0, aiFields)

    return jsonResponse(200, { ok: true, rawText: fullText || '', fields, ai: !!aiFields })
  } catch (err) {
    return jsonResponse(500, { ok: false, step: 'catch', error: 'unhandled_exception', detail: safeDetailFromError(err) })
  }
}
