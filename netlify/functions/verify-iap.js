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

function planConfigFromProduct(productId) {
  // Map store product IDs to internal plans.
  // Update these to match your Google Play / App Store product IDs.
  const id = String(productId || '').toLowerCase()

  if (!id) return null

  if (id.includes('pro')) {
    return { plan: 'pro', payer_limit: 2, ocr_quota_monthly: 300, exports_enabled: true, subscription_source: 'iap_google' }
  }
  if (id.includes('basic')) {
    return { plan: 'basic', payer_limit: 1, ocr_quota_monthly: 100, exports_enabled: true, subscription_source: 'iap_google' }
  }
  return null
}

async function activateEntitlementsForIap(supabase, userId, productId, platform) {
  const cfg = planConfigFromProduct(productId)
  if (!cfg) throw new Error('unknown_product')

  const nowIso = new Date().toISOString()
  const payload = {
    user_id: userId,
    plan: cfg.plan,
    payer_limit: cfg.payer_limit,
    ocr_quota_monthly: cfg.ocr_quota_monthly,
    exports_enabled: cfg.exports_enabled,
    subscription_source: platform === 'ios' ? 'iap_apple' : 'iap_google',
    status: 'active',
    updated_at: nowIso,
  }

  const { error } = await supabase
    .from('entitlements')
    .upsert(payload, { onConflict: 'user_id' })

  if (error) throw new Error(error.message || 'upsert_failed')
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const supabase = getSupabaseAdmin()
    if (!supabase) {
      return jsonResponse(500, { ok: false, error: 'supabase_not_configured' })
    }

    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      body = {}
    }

    const platform = String(body.platform || '').toLowerCase()
    const productId = String(body.productId || '')
    const userId = String(body.userId || '')

    if (!['ios', 'android'].includes(platform)) {
      return jsonResponse(400, { ok: false, error: 'invalid_platform' })
    }

    if (!productId) {
      return jsonResponse(400, { ok: false, error: 'missing_product_id' })
    }

    if (!userId) {
      return jsonResponse(400, { ok: false, error: 'missing_user_id' })
    }

    // NOTE: Real-world apps MUST verify the receipt / purchase token with
    // Apple / Google here using their server-side APIs and secrets.
    // This endpoint currently TRUSTS the client and only updates entitlements.
    // Replace this with proper verification before going live.

    await activateEntitlementsForIap(supabase, userId, productId, platform)

    return jsonResponse(200, { ok: true })
  } catch (err) {
    const msg = (err && err.message) || 'verify_iap_error'
    return jsonResponse(500, { ok: false, error: 'verify_iap_error', detail: msg })
  }
}
