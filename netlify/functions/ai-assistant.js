// Minimal Netlify Function: AI assistant endpoint.
// IMPORTANT: Keep API keys on the server only.

const { createClient } = require('@supabase/supabase-js')

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

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
  } catch {
    return { userId: null, error: 'invalid_token' }
  }
}

function isSameMonth(a, b) {
  if (!a || !b) return false
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
}

function nextMonthStartUtc(date) {
  const d = date instanceof Date ? date : new Date(date)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0))
}

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

  const authInfo = await getUserFromAuthHeader(event)
  if (!authInfo.userId || !authInfo.supabase) {
    return json(401, { error: 'auth_required', message: 'AI is not available right now.' })
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

  // Enforce per-plan AI limits before calling the model.
  try {
    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const { data } = await supabase
      .from('entitlements')
      .select('*')
      .eq('user_id', userId)
      .order('active_until', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const ent = data || { plan: 'free', status: 'active' }
    const status = String(ent.status || 'active').trim().toLowerCase()
    const rawPlan = String(ent.plan || 'free')
    const trialEndsAt = ent.trial_ends_at ? new Date(ent.trial_ends_at) : null
    const graceUntil = ent.grace_until ? new Date(ent.grace_until) : null
    const exportOnly = Boolean(ent.export_only)
    const deletedAt = ent.deleted_at ? new Date(ent.deleted_at) : null
    const deleteAt = ent.delete_at ? new Date(ent.delete_at) : null
    const now = new Date()

    let effectivePlan = rawPlan === 'basic' || rawPlan === 'pro' ? rawPlan : 'free'
    let allowed = true

    if (deletedAt || status === 'deleted' || (deleteAt && now >= deleteAt)) {
      allowed = false
    } else if (exportOnly || status === 'export_only') {
      allowed = false
    } else if (status === 'grace_period') {
      allowed = false
    } else if (status === 'cancelled_all') {
      allowed = false
    } else if (status === 'payment_failed' || status === 'subscription_cancelled' || status === 'trial_expired') {
      allowed = false
    } else if (status === 'active_vec') {
      effectivePlan = 'pro'
    } else if (status === 'active_moje' || status === 'downgrade_vec_to_moje') {
      effectivePlan = 'basic'
    } else if (status === 'trial_active') {
      if (trialEndsAt && now > trialEndsAt) {
        return json(403, { error: 'trial_expired', message: 'Trial expired.' })
      }
      effectivePlan = 'basic'
    } else if (status === 'grace_period' && graceUntil && now > graceUntil) {
      allowed = false
    }

    if (!allowed) {
      return json(403, { error: 'ai_not_allowed', message: 'AI is not available for this plan.' })
    }

    // Default quotas if not configured in DB.
    // IMPORTANT: AI must also work on the free/Moje plan, but with a small monthly question limit.
    const defaultQuota = effectivePlan === 'pro' ? 100 : effectivePlan === 'basic' ? 30 : 10
    const quota = typeof ent.ai_quota_monthly === 'number' ? ent.ai_quota_monthly : defaultQuota
    if (!quota) {
      return json(403, { error: 'ai_not_allowed', message: 'AI is not available for this plan.' })
    }

    const updatedAt = ent.ai_updated_at ? new Date(ent.ai_updated_at) : (ent.updated_at ? new Date(ent.updated_at) : null)
    let used = typeof ent.ai_used_this_month === 'number' ? ent.ai_used_this_month : 0
    if (!isSameMonth(now, updatedAt)) used = 0

    if (used >= quota) {
      const resetAt = nextMonthStartUtc(updatedAt || now).toISOString()
      return json(403, { error: 'ai_quota_exceeded', message: 'AI quota exceeded.', resetAt })
    }

    // Increment usage before calling model to avoid race conditions.
    const newUsed = used + 1
    await supabase
      .from('entitlements')
      .update({ ai_used_this_month: newUsed, ai_updated_at: now.toISOString(), updated_at: now.toISOString() })
      .eq('user_id', userId)
  } catch {
    return json(503, { error: 'ai_unavailable', message: 'AI is not available right now.' })
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
