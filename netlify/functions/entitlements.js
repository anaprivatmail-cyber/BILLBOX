import { createClient } from '@supabase/supabase-js'

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
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
  } catch {
    return { userId: null, error: 'invalid_token' }
  }
}

function normalizeEntitlements(row) {
  const plan = String(row?.plan || 'free')
  return {
    plan: plan === 'basic' || plan === 'pro' ? plan : 'free',
    payerLimit: typeof row?.payer_limit === 'number' ? row.payer_limit : plan === 'pro' ? 2 : 1,
    exportsEnabled: Boolean(row?.exports_enabled),
    ocrQuotaMonthly: typeof row?.ocr_quota_monthly === 'number' ? row.ocr_quota_monthly : plan === 'free' ? 3 : null,
    ocrUsedThisMonth: typeof row?.ocr_used_this_month === 'number' ? row.ocr_used_this_month : 0,
    updatedAt: row?.updated_at || null,
  }
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'GET') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const authInfo = await getUserFromAuthHeader(event)
    if (!authInfo.userId || !authInfo.supabase) {
      return jsonResponse(401, { ok: false, error: 'auth_required' })
    }

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const { data } = await supabase
      .from('entitlements')
      .select('*')
      .eq('user_id', userId)
      .order('active_until', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    let row = data

    // Ensure at least a Free row exists so quotas (OCR) can be tracked server-side.
    if (!row) {
      const nowIso = new Date().toISOString()
      const payload = {
        user_id: userId,
        plan: 'free',
        payer_limit: 1,
        exports_enabled: false,
        ocr_quota_monthly: 3,
        ocr_used_this_month: 0,
        subscription_source: 'free',
        status: 'active',
        updated_at: nowIso,
      }
      await supabase.from('entitlements').upsert(payload, { onConflict: 'user_id' })
      const { data: created } = await supabase
        .from('entitlements')
        .select('*')
        .eq('user_id', userId)
        .order('active_until', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      row = created || payload
    }

    return jsonResponse(200, { ok: true, entitlements: normalizeEntitlements(row) })
  } catch (err) {
    const msg = (err && err.message) || 'entitlements_error'
    return jsonResponse(500, { ok: false, error: 'entitlements_error', detail: msg })
  }
}
