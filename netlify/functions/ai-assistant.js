// Minimal Netlify Function: AI assistant endpoint.
// IMPORTANT: Keep API keys on the server only.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

function resolveModel() {
  const raw = process.env.OPENAI_MODEL
  const model = typeof raw === 'string' ? raw.trim() : ''
  // Default is cost-efficient and suitable for short help.
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

  const payload = safeParse(event.body) || {}
  const message = String(payload.message || '').trim()
  const context = payload.context || {}

  if (!message) {
    return json(400, { error: 'Missing message' })
  }

  if (!OPENAI_API_KEY) {
    return json(501, {
      error: 'AI is not configured on the server (missing OPENAI_API_KEY).',
      intent: 'error',
      message: 'AI is not configured for this environment.',
      suggestedActions: [],
    })
  }

  // Keep output short and structured.
  const system =
    'You are BillBox assistant. You respond with JSON ONLY. ' +
    'Schema: {"intent": string, "message": string, "suggestedActions": [{"label": string, "route": string, "params": object|null}]}. ' +
    'Keep message <= 80 words. Suggest 0-3 actions. ' +
    'Routes allowed: BillBox, Bills, Scan, Pay, Warranties, Reports, Exports, Settings, Payments, Inbox. ' +
    'Safety: never claim you paid a bill or completed a payment; only describe steps and remind user to verify IBAN/amount/reference.'

  const user =
    `User message: ${message}\n\n` +
    `App context (may be empty): ${JSON.stringify(context).slice(0, 4000)}`

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
        temperature: 0.2,
        // Keep responses short and bounded (tips/steps only).
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })

    const data = await resp.json().catch(() => null)
    if (!resp.ok) {
      return json(resp.status, {
        error: data?.error?.message || 'OpenAI request failed',
      })
    }

    const content = data?.choices?.[0]?.message?.content
    const parsed = safeParse(content)

    if (!parsed || typeof parsed !== 'object') {
      return json(502, { error: 'Invalid AI response' })
    }

    // Normalize fields.
    const out = {
      intent: typeof parsed.intent === 'string' ? parsed.intent : 'help',
      message: typeof parsed.message === 'string' ? parsed.message : 'Here are a few helpful next steps.',
      suggestedActions: Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions.slice(0, 3) : [],
    }

    return json(200, out)
  } catch (e) {
    return json(500, { error: e?.message || 'AI failed' })
  }
}
