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
    const plan = normalizePlan(row?.plan)
    const payerLimit = typeof row?.payer_limit === 'number' ? row.payer_limit : plan === 'pro' ? 2 : 1
    const exportsEnabled = Boolean(row?.exports_enabled)
    return { plan, payerLimit, exportsEnabled }
  } catch {
    return { plan: 'free', payerLimit: 1, exportsEnabled: false }
  }
}

export function isExportAllowed(plan, exportKind) {
  // Must match the app's UI copy:
  // Free: JSON only • Basic: CSV + JSON • Pro: CSV + PDF + ZIP + JSON
  if (exportKind === 'json') return true
  if (exportKind === 'csv') return plan === 'basic' || plan === 'pro'
  if (exportKind === 'pdf') return plan === 'pro'
  if (exportKind === 'zip') return plan === 'pro'
  return false
}

export function assertPayerScope(entitlements, spaceId) {
  const sid = String(spaceId || '')
  if (!sid) return { ok: true }
  // Payer 2 is reserved for Pro (payerLimit >= 2)
  if (sid === 'personal2' && (entitlements?.payerLimit || 1) < 2) {
    return { ok: false, code: 'payer_limit' }
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

export function buildBillQueryWithFilters({ supabase, userId, spaceId, filters }) {
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

  let q = supabase.from('bills').select('*').eq('user_id', userId)
  if (spaceId) q = q.eq('space_id', spaceId)

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
