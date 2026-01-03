import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2024-11-20', typescript: false })
}

function getWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || ''
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

function toBuffer(event) {
  if (event.isBase64Encoded) return Buffer.from(event.body || '', 'base64')
  return Buffer.from(event.body || '')
}

function planConfig(plan) {
  // Adjust as needed per your product definitions
  if (plan === 'pro') {
    return { plan: 'pro', payer_limit: 2, ocr_quota_monthly: 100, exports_enabled: true }
  }
  return { plan: 'basic', payer_limit: 1, ocr_quota_monthly: 20, exports_enabled: true }
}

async function activateEntitlements(supabase, userId, plan) {
  const cfg = planConfig(plan)
  const nowIso = new Date().toISOString()
  const payload = {
    user_id: userId,
    plan: cfg.plan,
    payer_limit: cfg.payer_limit,
    ocr_quota_monthly: cfg.ocr_quota_monthly,
    exports_enabled: cfg.exports_enabled,
    subscription_source: 'stripe',
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

    const stripe = getStripe()
    const secret = getWebhookSecret()
    if (!stripe || !secret) {
      return jsonResponse(500, { ok: false, error: 'webhook_not_configured' })
    }

    const buf = toBuffer(event)
    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature']
    let evt
    try {
      evt = stripe.webhooks.constructEvent(buf, sig, secret)
    } catch (e) {
      return jsonResponse(400, { ok: false, error: 'signature_verification_failed' })
    }

    // Handle relevant events
    if (evt.type === 'checkout.session.completed') {
      const session = evt.data.object
      const meta = session.metadata || {}
      const userId = String(meta.userId || '')
      const plan = String(meta.plan || 'basic').toLowerCase()
      const supabase = getSupabaseAdmin()
      if (userId && supabase) {
        try {
          await activateEntitlements(supabase, userId, ['pro', 'basic'].includes(plan) ? plan : 'basic')
        } catch (e) {
          return jsonResponse(500, { ok: false, error: 'entitlements_update_failed' })
        }
      }
      return jsonResponse(200, { ok: true })
    }

    // Optionally handle subscription lifecycle updates
    if (evt.type === 'customer.subscription.deleted') {
      const session = evt.data.object
      const meta = session.metadata || {}
      const userId = String(meta.userId || '')
      const supabase = getSupabaseAdmin()
      if (userId && supabase) {
        try {
          const { error } = await supabase
            .from('entitlements')
            .update({ plan: 'free', subscription_source: 'stripe', status: 'expired', updated_at: new Date().toISOString(), exports_enabled: false })
            .eq('user_id', userId)
          if (error) throw new Error(error.message || 'update_failed')
        } catch (_) {
          // swallow errors; respond 200 to avoid webhook retries loop
        }
      }
      return jsonResponse(200, { ok: true })
    }

    // default: acknowledge
    return jsonResponse(200, { ok: true })
  } catch (err) {
    const msg = (err && err.message) || 'webhook_error'
    return jsonResponse(500, { ok: false, error: 'webhook_error', detail: msg })
  }
}
