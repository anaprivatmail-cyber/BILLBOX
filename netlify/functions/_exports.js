import { createClient } from '@supabase/supabase-js'

export function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  }
}

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

export async function getUserFromAuthHeader(event) {
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
    return { userId: data.user.id, error: null, supabase, token }
  } catch {
    return { userId: null, error: 'invalid_token' }
  }
}

export async function safeJsonBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {}
  } catch {
    return {}
  }
}

function normalizePlan(plan) {
  const p = String(plan || 'free')
  return p === 'basic' || p === 'pro' ? p : 'free'
}

export async function loadEntitlements(supabase, userId) {
  try {
    const { data } = await supabase
      .from('entitlements')
      .select('*')
      .eq('user_id', userId)
      .order('active_until', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    const row = data || null
    const rawPlan = normalizePlan(row?.plan)
    const status = String(row?.status || 'active').trim().toLowerCase()
    const trialEndsAt = row?.trial_ends_at ? new Date(row.trial_ends_at) : null
    const graceUntil = row?.grace_until ? new Date(row.grace_until) : null
    const exportOnly = Boolean(row?.export_only)
    const deletedAt = row?.deleted_at ? new Date(row.deleted_at) : null
    const exportUntil = row?.export_until ? new Date(row.export_until) : null
    const deleteAt = row?.delete_at ? new Date(row.delete_at) : null
    const downgradeCleanupAt = row?.downgrade_cleanup_at ? new Date(row.downgrade_cleanup_at) : null
    const now = new Date()

    let effectivePlan = rawPlan
    let exportsEnabled = Boolean(row?.exports_enabled)
    let allowed = true
    let lifecycleStatus = 'active'

    if (deletedAt || status === 'deleted' || (deleteAt && now >= deleteAt)) {
      allowed = false
      lifecycleStatus = 'deleted'
    } else if (status === 'export_only') {
      lifecycleStatus = 'export_only'
      exportsEnabled = true
      effectivePlan = 'free'
    } else if (status === 'grace_period') {
      lifecycleStatus = 'grace_period'
      effectivePlan = 'free'
      exportsEnabled = false
      allowed = true
    } else if (status === 'downgrade_vec_to_moje') {
      lifecycleStatus = 'downgrade_vec_to_moje'
      effectivePlan = 'basic'
      exportsEnabled = false
    } else if (status === 'cancelled_all') {
      allowed = false
      lifecycleStatus = 'cancelled_all'
    } else if (status === 'payment_failed' || status === 'subscription_cancelled' || status === 'trial_expired') {
      allowed = false
      lifecycleStatus = 'cancelled_all'
    } else if (status === 'trial_active') {
      if (trialEndsAt && now > trialEndsAt) {
        allowed = false
        lifecycleStatus = 'cancelled_all'
      } else {
        effectivePlan = 'basic'
        exportsEnabled = false
        lifecycleStatus = 'active_moje'
      }
    } else {
      lifecycleStatus = rawPlan === 'pro' ? 'active_vec' : rawPlan === 'basic' ? 'active_moje' : 'active_moje'
    }

    if (!allowed) {
      effectivePlan = 'free'
      exportsEnabled = false
    }

    const payerLimit = typeof row?.payer_limit === 'number' ? row.payer_limit : effectivePlan === 'pro' ? 2 : 1
    const spaceId = row?.space_id ? String(row.space_id) : null
    const spaceId2 = row?.space_id2 ? String(row.space_id2) : (row?.space_id_2 ? String(row.space_id_2) : null)
    return {
      plan: effectivePlan,
      rawPlan,
      status,
      lifecycleStatus,
      payerLimit,
      exportsEnabled,
      spaceId,
      spaceId2,
      exportUntil: exportUntil ? exportUntil.toISOString() : null,
      deleteAt: deleteAt ? deleteAt.toISOString() : null,
      downgradeCleanupAt: downgradeCleanupAt ? downgradeCleanupAt.toISOString() : null,
    }
  } catch {
    return {
      plan: 'free',
      rawPlan: 'free',
      status: 'active',
      lifecycleStatus: 'active_moje',
      payerLimit: 1,
      exportsEnabled: false,
      spaceId: null,
      spaceId2: null,
      exportUntil: null,
      deleteAt: null,
      downgradeCleanupAt: null,
    }
  }
}

export function isExportAllowed(entitlements, exportKind, options = {}) {
  const e = entitlements || {}
  const lifecycle = String(e.lifecycleStatus || e.status || 'active').trim().toLowerCase()
  const plan = String(e.plan || 'free')

  if (lifecycle === 'deleted' || lifecycle === 'grace_period') return false
  if (lifecycle === 'export_only') return true
  if (lifecycle === 'downgrade_vec_to_moje') {
    return exportKind === 'zip' && options?.allowDowngradeExport === true
  }

  if (exportKind === 'json') return plan === 'pro'
  if (exportKind === 'csv') return plan === 'pro'
  if (exportKind === 'pdf') return plan === 'pro'
  if (exportKind === 'zip') return plan === 'pro'
  return false
}

export function assertPayerScope(entitlements, spaceIdOrIds) {
  const ids = Array.isArray(spaceIdOrIds)
    ? spaceIdOrIds.map((v) => String(v || '').trim()).filter(Boolean)
    : [String(spaceIdOrIds || '').trim()].filter(Boolean)

  if (!ids.length) return { ok: true }

  const e = entitlements || {}
  const lifecycle = String(e.lifecycleStatus || e.status || 'active').trim().toLowerCase()
  const exportOverride = lifecycle === 'export_only'
  const payerLimit = exportOverride ? 2 : Number(e.payerLimit || 1)
  const allowed1 = e.spaceId ? String(e.spaceId) : ''
  const allowed2 = e.spaceId2 ? String(e.spaceId2) : ''

  for (const sid of ids) {
    if (allowed1 && sid === allowed1) continue
    if (allowed2 && sid === allowed2) {
      if (payerLimit < 2) return { ok: false, code: 'payer_limit' }
      continue
    }
    return { ok: false, code: 'invalid_space' }
  }
  return { ok: true }
}

export function sanitizeFilename(name, fallback) {
  const base = (String(name || '').trim() || fallback || 'export')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return base || 'export'
}

export function sanitizePathSegment(value) {
  return String(value || '').replace(/[^a-z0-9._-]/gi, '_') || 'item'
}

export async function uploadAndSign({ supabase, bucket, path, buffer, contentType, expiresIn = 600 }) {
  const sizeBytes = buffer?.length || 0
  const upload = await supabase.storage.from(bucket).upload(path, buffer, {
    upsert: true,
    contentType: contentType || 'application/octet-stream',
  })
  if (upload.error) {
    return { ok: false, error: 'upload_failed', detail: upload.error.message }
  }

  const signed = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn)
  if (signed.error || !signed.data?.signedUrl) {
    return { ok: false, error: 'signed_url_failed', detail: signed.error?.message || 'no_url' }
  }

  return {
    ok: true,
    url: signed.data.signedUrl,
    sizeBytes,
  }
}

export function buildBillQueryWithFilters({ supabase, userId, spaceId, spaceIds, filters }) {
  const f = filters || {}
  const start = String(f.start || '')
  const end = String(f.end || '')
  const dateMode = String(f.dateMode || 'due')
  const supplierQuery = String(f.supplierQuery || '').trim()
  const status = String(f.status || 'all')
  const hasAttachmentsOnly = Boolean(f.hasAttachmentsOnly)

  const amountMinRaw = f.amountMin
  const amountMaxRaw = f.amountMax
  const minVal = amountMinRaw !== null && amountMinRaw !== undefined && String(amountMinRaw).trim() !== ''
    ? Number(String(amountMinRaw).replace(',', '.'))
    : null
  const maxVal = amountMaxRaw !== null && amountMaxRaw !== undefined && String(amountMaxRaw).trim() !== ''
    ? Number(String(amountMaxRaw).replace(',', '.'))
    : null

  const ids = Array.isArray(spaceIds)
    ? spaceIds.map((v) => String(v || '').trim()).filter(Boolean)
    : []

  let q = supabase.from('bills').select('*').eq('user_id', userId)
  if (ids.length) q = q.in('space_id', ids)
  else if (spaceId) q = q.eq('space_id', spaceId)

  if (status !== 'all') q = q.eq('status', status)
  if (supplierQuery) {
    const term = supplierQuery.replace(/%/g, '')
    // Match app filter behavior: supplier substring match.
    q = q.ilike('supplier', `%${term}%`)
  }
  if (minVal !== null && !Number.isNaN(minVal)) q = q.gte('amount', minVal)
  if (maxVal !== null && !Number.isNaN(maxVal)) q = q.lte('amount', maxVal)

  // Date filtering: emulate app behavior.
  if (start && end) {
    if (dateMode === 'created') {
      // created_at is timestamptz; use full-day bounds.
      q = q.gte('created_at', `${start}T00:00:00.000Z`).lte('created_at', `${end}T23:59:59.999Z`)
    } else if (dateMode === 'invoice') {
      // invoice_date is sometimes null; app falls back to created_at.
      q = q.or(
        `and(invoice_date.gte.${start},invoice_date.lte.${end}),and(invoice_date.is.null,created_at.gte.${start}T00:00:00.000Z,created_at.lte.${end}T23:59:59.999Z)`
      )
    } else {
      // due
      q = q.gte('due_date', start).lte('due_date', end)
    }
  }

  // Caller may need to apply hasAttachmentsOnly post-query.
  return { query: q, hasAttachmentsOnly }
}
