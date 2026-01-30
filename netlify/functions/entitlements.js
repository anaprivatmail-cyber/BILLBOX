import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

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
  const isComp = Boolean(row?.is_comp) || String(row?.subscription_source || '').trim().toLowerCase() === 'comp'
  const plan = String(row?.plan || 'free')
  const spaceId = row?.space_id ? String(row.space_id) : null
  const spaceId2 = row?.space_id2 ? String(row.space_id2) : (row?.space_id_2 ? String(row.space_id_2) : null)
  const statusRaw = String(row?.status || 'active')
  const status = statusRaw.trim().toLowerCase()
  const trialEndsAt = row?.trial_ends_at || row?.trialEndsAt || null
  const graceUntil = row?.grace_until || row?.graceUntil || null
  const paymentFailedAt = row?.payment_failed_at || row?.paymentFailedAt || null
  const cancelledAt = row?.cancelled_at || row?.canceled_at || row?.cancelledAt || row?.canceledAt || null
  const deletedAt = row?.deleted_at || row?.deletedAt || null
  const exportOnly = Boolean(row?.export_only || row?.exportOnly)
  const exportUntil = row?.export_until || row?.exportUntil || null
  const deleteAt = row?.delete_at || row?.deleteAt || null
  const downgradeCleanupAt = row?.downgrade_cleanup_at || row?.downgradeCleanupAt || null

  const now = new Date()
  const trialEnds = trialEndsAt ? new Date(trialEndsAt) : null
  const graceEnds = graceUntil ? new Date(graceUntil) : null

  let effectiveStatus = status
  let effectivePlan = plan === 'basic' || plan === 'pro' ? plan : 'free'
  let effectiveExportsEnabled = Boolean(row?.exports_enabled)
  let effectiveCanUseOcr = true
  let lifecycleStatus = 'active'

  if (deletedAt || status === 'deleted' || (deleteAt && now >= new Date(deleteAt))) {
    effectiveStatus = 'deleted'
    lifecycleStatus = 'deleted'
    effectivePlan = 'free'
    effectiveExportsEnabled = false
    effectiveCanUseOcr = false
  } else if (isComp) {
    // Admin/comp override: permanent Pro/Več access that should not be overwritten by billing state.
    // Still respect deletion flags above.
    effectiveStatus = 'active'
    lifecycleStatus = 'active_vec'
    effectivePlan = 'pro'
    effectiveExportsEnabled = true
    effectiveCanUseOcr = true
  } else if (status === 'export_only') {
    effectiveStatus = 'export_only'
    lifecycleStatus = 'export_only'
    effectivePlan = 'free'
    effectiveExportsEnabled = true
    effectiveCanUseOcr = false
  } else if (status === 'grace_period') {
    effectiveStatus = 'grace_period'
    lifecycleStatus = 'grace_period'
    effectivePlan = 'free'
    effectiveExportsEnabled = false
    effectiveCanUseOcr = false
  } else if (status === 'downgrade_vec_to_moje') {
    effectiveStatus = 'downgrade_vec_to_moje'
    lifecycleStatus = 'downgrade_vec_to_moje'
    effectivePlan = 'basic'
    effectiveExportsEnabled = false
    effectiveCanUseOcr = true
  } else if (status === 'cancelled_all') {
    lifecycleStatus = 'cancelled_all'
    effectivePlan = 'free'
    effectiveExportsEnabled = false
    effectiveCanUseOcr = false
  } else if (status === 'payment_failed' || status === 'subscription_cancelled' || status === 'trial_expired') {
    lifecycleStatus = 'cancelled_all'
    effectivePlan = 'free'
    effectiveExportsEnabled = false
    effectiveCanUseOcr = false
  } else if (status === 'trial_active') {
    if (trialEnds && now > trialEnds) {
      effectiveStatus = 'trial_expired'
      lifecycleStatus = 'cancelled_all'
      effectivePlan = 'free'
      effectiveExportsEnabled = false
      effectiveCanUseOcr = false
    } else {
      lifecycleStatus = 'active_moje'
      effectivePlan = 'basic'
      effectiveExportsEnabled = false
      effectiveCanUseOcr = true
    }
  } else {
    lifecycleStatus = effectivePlan === 'pro' ? 'active_vec' : 'active_moje'
  }

  const effectivePayerLimit = effectivePlan === 'pro' ? 2 : 1
  return {
    plan: effectivePlan,
    rawPlan: plan === 'basic' || plan === 'pro' ? plan : 'free',
    status: effectiveStatus,
    trialEndsAt: trialEndsAt || null,
    graceUntil: graceUntil || null,
    paymentFailedAt: paymentFailedAt || null,
    cancelledAt: cancelledAt || null,
    deletedAt: deletedAt || null,
    exportOnly: exportOnly,
    exportUntil: exportUntil || null,
    deleteAt: deleteAt || null,
    downgradeCleanupAt: downgradeCleanupAt || null,
    lifecycleStatus,
    payerLimit: typeof row?.payer_limit === 'number' ? row.payer_limit : effectivePayerLimit,
    exportsEnabled: effectiveExportsEnabled,
    canUseOcr: effectiveCanUseOcr,
    ocrQuotaMonthly: typeof row?.ocr_quota_monthly === 'number' ? row.ocr_quota_monthly : effectivePlan === 'free' ? 3 : null,
    ocrUsedThisMonth: typeof row?.ocr_used_this_month === 'number' ? row.ocr_used_this_month : 0,
    ocrUpdatedAt: row?.ocr_updated_at || null,
    aiQuotaMonthly: typeof row?.ai_quota_monthly === 'number' ? row.ai_quota_monthly : (effectivePlan === 'pro' ? 100 : effectivePlan === 'basic' ? 30 : 0),
    aiUsedThisMonth: typeof row?.ai_used_this_month === 'number' ? row.ai_used_this_month : 0,
    spaceId,
    spaceId2,
    updatedAt: row?.updated_at || null,
  }
}

function addDays(date, days) {
  const out = new Date(date.getTime())
  out.setDate(out.getDate() + days)
  return out
}

async function ensureEntitlementsSpaceIds(supabase, userId, row) {
  if (!row) return row
  const updates = {}
  if (!row.space_id) updates.space_id = randomUUID()

  const payerLimit = typeof row?.payer_limit === 'number' ? row.payer_limit : 1
  const hasSpaceId2 = Object.prototype.hasOwnProperty.call(row, 'space_id2')
  const hasSpaceId_2 = Object.prototype.hasOwnProperty.call(row, 'space_id_2')
  if (payerLimit >= 2) {
    if (hasSpaceId2 && !row.space_id2) updates.space_id2 = randomUUID()
    if (hasSpaceId_2 && !row.space_id_2) updates.space_id_2 = randomUUID()
  }

  if (!Object.keys(updates).length) return row
  try {
    await supabase.from('entitlements').update(updates).eq('user_id', userId)
    return { ...row, ...updates }
  } catch {
    return { ...row, ...updates }
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

    // Ensure at least a Trial row exists so new users get 7 days of Moje.
    if (!row) {
      const nowIso = new Date().toISOString()
      const trialEnds = addDays(new Date(), 7).toISOString()
      const payload = {
        user_id: userId,
        plan: 'basic',
        payer_limit: 1,
        exports_enabled: false,
        ocr_quota_monthly: 50,
        ocr_used_this_month: 0,
        ai_quota_monthly: 30,
        ai_used_this_month: 0,
        subscription_source: 'trial',
        status: 'trial_active',
        trial_ends_at: trialEnds,
        space_id: randomUUID(),
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

    // Handle trial / grace / export-only expiry transitions.
    try {
      const now = new Date()
      const isComp = Boolean(row?.is_comp) || String(row?.subscription_source || '').trim().toLowerCase() === 'comp'
      if (isComp) {
        row = await ensureEntitlementsSpaceIds(supabase, userId, row)
        return jsonResponse(200, { ok: true, entitlements: normalizeEntitlements(row) })
      }
      const status = String(row?.status || 'active').trim().toLowerCase()
      const trialEndsAt = row?.trial_ends_at ? new Date(row.trial_ends_at) : null
      const graceUntil = row?.grace_until ? new Date(row.grace_until) : null
      const exportUntil = row?.export_until ? new Date(row.export_until) : null
      const deleteAt = row?.delete_at ? new Date(row.delete_at) : null
      const activeUntil = row?.active_until ? new Date(row.active_until) : null

      if (status === 'trial_active' && trialEndsAt && now > trialEndsAt) {
        const payload = {
          plan: 'free',
          payer_limit: 1,
          exports_enabled: false,
          ocr_quota_monthly: 3,
          ai_quota_monthly: 0,
          status: 'trial_expired',
          updated_at: now.toISOString(),
        }
        await supabase.from('entitlements').update(payload).eq('user_id', userId)
        row = { ...row, ...payload }
      }

      if (deleteAt && now >= deleteAt) {
        const payload = {
          plan: 'free',
          payer_limit: 1,
          exports_enabled: false,
          ocr_quota_monthly: 3,
          ai_quota_monthly: 0,
          status: 'deleted',
          export_only: false,
          deleted_at: now.toISOString(),
          updated_at: now.toISOString(),
        }
        await supabase.from('entitlements').update(payload).eq('user_id', userId)
        row = { ...row, ...payload }
      } else if (status === 'export_only' && exportUntil && now > exportUntil) {
        const payload = {
          plan: 'free',
          payer_limit: 1,
          exports_enabled: false,
          ocr_quota_monthly: 3,
          ai_quota_monthly: 0,
          status: 'deleted',
          export_only: false,
          deleted_at: now.toISOString(),
          updated_at: now.toISOString(),
        }
        await supabase.from('entitlements').update(payload).eq('user_id', userId)
        row = { ...row, ...payload }
      } else if (status === 'cancelled_all' && (!activeUntil || now > activeUntil)) {
        const nextGraceUntil = graceUntil ? graceUntil.toISOString() : addDays(now, 30).toISOString()
        const nextExportUntil = exportUntil ? exportUntil.toISOString() : addDays(new Date(nextGraceUntil), 30).toISOString()
        const payload = {
          plan: 'free',
          payer_limit: 1,
          exports_enabled: false,
          ocr_quota_monthly: 3,
          ai_quota_monthly: 0,
          status: 'grace_period',
          grace_until: nextGraceUntil,
          export_until: nextExportUntil,
          delete_at: row?.delete_at || nextExportUntil,
          export_only: false,
          updated_at: now.toISOString(),
        }
        await supabase.from('entitlements').update(payload).eq('user_id', userId)
        row = { ...row, ...payload }
      } else if (status === 'grace_period' && graceUntil && now > graceUntil) {
        const nextExportUntil = exportUntil ? exportUntil.toISOString() : addDays(now, 30).toISOString()
        const payload = {
          plan: 'free',
          payer_limit: 1,
          exports_enabled: true,
          ocr_quota_monthly: 3,
          ai_quota_monthly: 0,
          status: 'export_only',
          export_only: true,
          export_until: nextExportUntil,
          delete_at: row?.delete_at || nextExportUntil,
          updated_at: now.toISOString(),
        }
        await supabase.from('entitlements').update(payload).eq('user_id', userId)
        row = { ...row, ...payload }
      }
    } catch {
      // non-fatal
    }

    row = await ensureEntitlementsSpaceIds(supabase, userId, row)

    return jsonResponse(200, { ok: true, entitlements: normalizeEntitlements(row) })
  } catch (err) {
    const msg = (err && err.message) || 'entitlements_error'
    return jsonResponse(500, { ok: false, error: 'entitlements_error', detail: msg })
  }
}
