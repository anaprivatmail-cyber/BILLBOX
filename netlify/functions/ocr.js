import { GoogleAuth } from 'google-auth-library'

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

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
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

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || ''

    let base64Image
    if (/^image\//i.test(contentType)) {
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

    if (!base64Image || String(base64Image).length < 16) {
      return jsonResponse(400, { ok: false, error: 'empty_image' })
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

    const annotation = raw?.responses?.[0]
    const fullText = annotation?.fullTextAnnotation?.text || annotation?.textAnnotations?.[0]?.description || ''
    const fields = extractFields(fullText || '')

    return jsonResponse(200, { ok: true, rawText: fullText || '', fields })
  } catch (err) {
    return jsonResponse(500, { ok: false, step: 'catch', error: 'unhandled_exception', detail: safeDetailFromError(err) })
  }
}
