import {
  jsonResponse,
  getUserFromAuthHeader,
  safeJsonBody,
  loadEntitlements,
  isExportAllowed,
  assertPayerScope,
} from './_exports.js'

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

    const body = await safeJsonBody(event)

    const from = String(body.from || '')
    const to = String(body.to || '')
    const dateField = String(body.dateField || 'due_date') // due_date | created_at
    const spaceId = body.spaceId ? String(body.spaceId) : null
    const spaceIdsRaw = Array.isArray(body.spaceIds)
      ? body.spaceIds
      : Array.isArray(body.space_ids)
        ? body.space_ids
        : null
    const spaceIds = spaceIdsRaw
      ? spaceIdsRaw.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 5)
      : []

    if (!from || !to) {
      return jsonResponse(400, { ok: false, error: 'missing_range', message: 'from/to required' })
    }

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const ent = await loadEntitlements(supabase, userId)
    if (!isExportAllowed(ent, 'csv')) {
      return jsonResponse(403, { ok: false, error: 'export_not_allowed', message: 'Exports not available on your plan.' })
    }

    const requestedSpaceIds = spaceIds.length ? spaceIds : (spaceId ? [spaceId] : [])
    const payerCheck = assertPayerScope(ent, requestedSpaceIds)
    if (!payerCheck.ok) {
      return jsonResponse(403, { ok: false, error: 'payer_limit', message: 'Upgrade required for Profil 2.' })
    }

    // Query bills
    const field = dateField === 'created_at' ? 'created_at' : 'due_date'
    let q = supabase
      .from('bills')
      .select('*')
      .eq('user_id', userId)
      .gte(field, from)
      .lte(field, to)
      .order(field, { ascending: true })
    if (requestedSpaceIds.length === 1) q = q.eq('space_id', requestedSpaceIds[0])
    else if (requestedSpaceIds.length > 1) q = q.in('space_id', requestedSpaceIds)

    const { data: bills, error } = await q

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
        b.invoice_number || '',
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
