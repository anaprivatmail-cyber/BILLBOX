import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const GRACE_DAYS = 30
const EXPORT_ONLY_DAYS = 30
const DOWNGRADE_EXPORT_DAYS = 30

function addDays(date, days) {
  const out = new Date(date.getTime())
  out.setDate(out.getDate() + days)
  return out
}

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

async function isCompOverrideUser(supabase, userId) {
  if (!supabase || !userId) return false
  try {
    const { data, error } = await supabase
      .from('entitlements')
      .select('*')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    if (error) return false
    return Boolean(data?.is_comp) || String(data?.subscription_source || '').trim().toLowerCase() === 'comp'
  } catch {
    return false
  }
}

async function updateEntitlementsStatus(supabase, userId, patch) {
  if (!supabase || !userId) return
  if (await isCompOverrideUser(supabase, userId)) return
  const payload = { ...patch, updated_at: new Date().toISOString() }
  await supabase.from('entitlements').update(payload).eq('user_id', userId)
}

function planConfig(plan) {
  // Adjust as needed per your product definitions
  if (plan === 'pro') {
    return { plan: 'pro', payer_limit: 2, ocr_quota_monthly: 100, ai_quota_monthly: 100, exports_enabled: true, status: 'active_pro' }
  }
  return { plan: 'basic', payer_limit: 1, ocr_quota_monthly: 50, ai_quota_monthly: 30, exports_enabled: false, status: 'active_basic' }
}

async function activateEntitlements(supabase, userId, plan) {
  if (await isCompOverrideUser(supabase, userId)) return
  const cfg = planConfig(plan)
  const nowIso = new Date().toISOString()
  let prevPlan = null
  try {
    const { data } = await supabase
      .from('entitlements')
      .select('plan')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle()
    prevPlan = data?.plan ? String(data.plan) : null
  } catch {
    prevPlan = null
  }

  const normalizedPlan = cfg.plan === 'pro' ? 'pro' : 'basic'
  const isDowngrade = prevPlan === 'pro' && normalizedPlan === 'basic'
  const downgradeCleanupAt = isDowngrade ? addDays(new Date(), DOWNGRADE_EXPORT_DAYS).toISOString() : null
  const status = normalizedPlan === 'pro' ? 'active_vec' : 'active_moje'
  const payload = {
    user_id: userId,
    plan: normalizedPlan,
    payer_limit: cfg.payer_limit,
    ocr_quota_monthly: cfg.ocr_quota_monthly,
    ai_quota_monthly: cfg.ai_quota_monthly,
    exports_enabled: cfg.exports_enabled,
    subscription_source: 'stripe',
    status: isDowngrade ? 'downgrade_vec_to_moje' : status,
    export_only: false,
    grace_until: null,
    export_until: null,
    delete_at: null,
    downgrade_cleanup_at: downgradeCleanupAt,
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

    // Subscription lifecycle updates
    if (evt.type === 'invoice.payment_failed') {
      const invoice = evt.data.object
      const meta = invoice.metadata || {}
      const userId = String(meta.userId || '')
      const supabase = getSupabaseAdmin()
      if (userId && supabase) {
        try {
          const graceUntil = addDays(new Date(), GRACE_DAYS)
          const exportUntil = addDays(graceUntil, EXPORT_ONLY_DAYS)
          await updateEntitlementsStatus(supabase, userId, {
            plan: 'free',
            payer_limit: 1,
            exports_enabled: false,
            ocr_quota_monthly: 3,
            ai_quota_monthly: 0,
            subscription_source: 'stripe',
            status: 'grace_period',
            payment_failed_at: new Date().toISOString(),
            grace_until: graceUntil.toISOString(),
            export_until: exportUntil.toISOString(),
            delete_at: exportUntil.toISOString(),
            export_only: false,
            downgrade_cleanup_at: null,
          })
        } catch {
          // swallow errors; respond 200 to avoid webhook retries loop
        }
      }
      return jsonResponse(200, { ok: true })
    }

    if (evt.type === 'customer.subscription.updated') {
      const sub = evt.data.object
      const meta = sub.metadata || {}
      const userId = String(meta.userId || '')
      const supabase = getSupabaseAdmin()
      if (userId && supabase) {
        try {
          if (sub.cancel_at_period_end) {
            const activeUntil = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
            const cancelledAt = new Date().toISOString()
            await updateEntitlementsStatus(supabase, userId, {
              status: 'cancelled_all',
              cancelled_at: cancelledAt,
              active_until: activeUntil,
              subscription_source: 'stripe',
            })
          } else {
            await updateEntitlementsStatus(supabase, userId, {
              status: 'active_vec',
              grace_until: null,
              export_until: null,
              delete_at: null,
              cancelled_at: null,
              export_only: false,
              subscription_source: 'stripe',
            })
          }
        } catch {
          // swallow errors
        }
      }
      return jsonResponse(200, { ok: true })
    }

    if (evt.type === 'customer.subscription.deleted') {
      const session = evt.data.object
      const meta = session.metadata || {}
      const userId = String(meta.userId || '')
      const supabase = getSupabaseAdmin()
      if (userId && supabase) {
        try {
          const graceUntil = addDays(new Date(), GRACE_DAYS)
          const exportUntil = addDays(graceUntil, EXPORT_ONLY_DAYS)
          await updateEntitlementsStatus(supabase, userId, {
            plan: 'free',
            payer_limit: 1,
            exports_enabled: false,
            ocr_quota_monthly: 3,
            ai_quota_monthly: 0,
            subscription_source: 'stripe',
            status: 'grace_period',
            cancelled_at: new Date().toISOString(),
            grace_until: graceUntil.toISOString(),
            export_until: exportUntil.toISOString(),
            delete_at: exportUntil.toISOString(),
            export_only: false,
            downgrade_cleanup_at: null,
          })
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
