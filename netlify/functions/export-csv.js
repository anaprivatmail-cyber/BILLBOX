import { createClient } from '@supabase/supabase-js'

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
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

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value)
  const escaped = s.replace(/"/g, '""')
  return `"${escaped}"`
}

function toCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n')
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const authInfo = await getUserFromAuthHeader(event)
    if (!authInfo.userId || !authInfo.supabase) {
      return jsonResponse(401, { ok: false, error: 'auth_required' })
    }

    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      body = {}
    }

    const from = String(body.from || '')
    const to = String(body.to || '')
    const dateField = String(body.dateField || 'due_date') // due_date | created_at

    if (!from || !to) {
      return jsonResponse(400, { ok: false, error: 'missing_range', message: 'from/to required' })
    }

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    // Enforce entitlements server-side
    let ent
    try {
      const { data } = await supabase
        .from('entitlements')
        .select('*')
        .eq('user_id', userId)
        .order('active_until', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      ent = data || { plan: 'free', exports_enabled: false }
    } catch {
      ent = { plan: 'free', exports_enabled: false }
    }

    if (!ent.exports_enabled) {
      return jsonResponse(403, { ok: false, error: 'export_not_allowed', message: 'Exports not available on your plan.' })
    }

    // Query bills
    const field = dateField === 'created_at' ? 'created_at' : 'due_date'
    const { data: bills, error } = await supabase
      .from('bills')
      .select('*')
      .eq('user_id', userId)
      .gte(field, from)
      .lte(field, to)
      .order(field, { ascending: true })

    if (error) {
      return jsonResponse(500, { ok: false, error: 'query_failed', detail: error.message })
    }

    // Accounting-ready header (includes extra columns as placeholders)
    const header = [
      'supplier',
      'creditor_name',
      'amount',
      'currency',
      'due_date',
      'status',
      'iban',
      'reference',
      'purpose',
      'created_at',
      'space_id',
      // Common accounting import placeholders:
      'invoice_number',
      'invoice_date',
      'net_amount',
      'vat_rate',
      'vat_amount',
      'gross_amount',
      'supplier_tax_id',
      'supplier_address',
    ]

    const rows = [header]

    for (const b of bills || []) {
      const gross = b.amount
      rows.push([
        b.supplier,
        b.creditor_name,
        b.amount,
        b.currency,
        b.due_date,
        b.status,
        b.iban,
        b.reference,
        b.purpose,
        b.created_at,
        b.space_id,
        '',
        '',
        '',
        '',
        '',
        gross,
        '',
        '',
      ])
    }

    const csv = toCsv(rows)

    return jsonResponse(200, { ok: true, csv })
  } catch (err) {
    const msg = (err && err.message) || 'export_csv_error'
    return jsonResponse(500, { ok: false, error: 'export_csv_error', detail: msg })
  }
}
