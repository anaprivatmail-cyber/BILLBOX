// Netlify Function: secure i18n translation endpoint for dev tooling (i18n-sync)
// Uses server-side OPENAI_API_KEY. Protect with I18N_TRANSLATE_TOKEN.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const I18N_TRANSLATE_TOKEN = process.env.I18N_TRANSLATE_TOKEN

function resolveModel() {
  const raw = process.env.OPENAI_MODEL
  const model = typeof raw === 'string' ? raw.trim() : ''
  return model || 'gpt-4.1-mini'
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

function safeParse(body) {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  // Require a token to avoid exposing your OpenAI key via a public endpoint.
  if (!I18N_TRANSLATE_TOKEN) {
    return json(501, { error: 'Server is missing I18N_TRANSLATE_TOKEN.' })
  }

  const provided = event.headers?.['x-i18n-token'] || event.headers?.['X-I18N-Token']
  if (!provided || String(provided) !== String(I18N_TRANSLATE_TOKEN)) {
    return json(401, { error: 'Unauthorized' })
  }

  if (!OPENAI_API_KEY) {
    return json(501, { error: 'Missing OPENAI_API_KEY on server.' })
  }

  const payload = safeParse(event.body) || {}
  const phrases = Array.isArray(payload.phrases) ? payload.phrases : []

  const cleaned = phrases
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .slice(0, 30)

  if (cleaned.length === 0) {
    return json(400, { error: 'Missing phrases' })
  }

  const system =
    'You are a professional UI translator for a bill/payment app. ' +
    'Translate each English UI phrase into Slovenian (sl), Croatian (hr), Italian (it), and German (de). ' +
    'Return JSON ONLY with schema: {sl: {"<phrase>": "<translation>"}, hr: {...}, it: {...}, de: {...}}. ' +
    'Rules: preserve placeholders like {count}, {email}, {field}; preserve punctuation; keep short. ' +
    'Do NOT translate: BillBox, IBAN, QR, CSV, PDF, JSON, ZIP, Pro, Basic, Free, EUR, €, YYYY-MM-DD.'

  const user = JSON.stringify({ phrases: cleaned }, null, 2)

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
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      return json(resp.status, { error: data?.error?.message || 'OpenAI request failed' })
    }

    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParse(content)

    if (!parsed || typeof parsed !== 'object') {
      return json(502, { error: 'Invalid AI response' })
    }

    const out = {
      sl: parsed.sl && typeof parsed.sl === 'object' ? parsed.sl : {},
      hr: parsed.hr && typeof parsed.hr === 'object' ? parsed.hr : {},
      it: parsed.it && typeof parsed.it === 'object' ? parsed.it : {},
      de: parsed.de && typeof parsed.de === 'object' ? parsed.de : {},
    }

    return json(200, out)
  } catch (e) {
    return json(500, { error: e?.message || 'Translation failed' })
  }
}
