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

function normalizeSpaceId(v) {
  const s = String(v || '').trim()
  return s ? s : 'default'
}

function buildForwardingAddress(aliasToken) {
  const domain = String(process.env.INBOUND_EMAIL_DOMAIN || '').trim()
  const prefix = String(process.env.INBOUND_EMAIL_PREFIX || 'billbox').trim() || 'billbox'
  if (!domain) return null
  return `${prefix}+${aliasToken}@${domain}`
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const authInfo = await getUserFromAuthHeader(event)
    if (!authInfo.userId || !authInfo.supabase) {
      return jsonResponse(401, { ok: false, error: 'auth_required' })
    }

    let spaceId = 'default'
    if (event.httpMethod === 'GET') {
      const raw = event.queryStringParameters?.spaceId || event.queryStringParameters?.space_id
      spaceId = normalizeSpaceId(raw)
    } else {
      let body = {}
      try {
        body = JSON.parse(event.body || '{}')
      } catch {
        body = {}
      }
      spaceId = normalizeSpaceId(body.spaceId || body.space_id)
    }

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const { data: existing, error: selErr } = await supabase
      .from('inbound_email_aliases')
      .select('id, alias_token, active')
      .eq('user_id', userId)
      .eq('space_id', spaceId)
      .limit(1)
      .maybeSingle()

    if (selErr) {
      return jsonResponse(500, { ok: false, error: 'query_failed', detail: selErr.message })
    }

    let row = existing
    if (!row) {
      const { data: inserted, error: insErr } = await supabase
        .from('inbound_email_aliases')
        .insert({ user_id: userId, space_id: spaceId, active: true })
        .select('id, alias_token, active')
        .single()
      if (insErr) {
        return jsonResponse(500, { ok: false, error: 'insert_failed', detail: insErr.message })
      }
      row = inserted
    }

    const aliasToken = String(row.alias_token || '').trim()
    const address = aliasToken ? buildForwardingAddress(aliasToken) : null

    return jsonResponse(200, {
      ok: true,
      spaceId,
      aliasToken,
      address,
      active: Boolean(row.active),
      configured: Boolean(address),
      missingConfig: address ? [] : ['INBOUND_EMAIL_DOMAIN'],
    })
  } catch (e) {
    return jsonResponse(500, { ok: false, error: 'inbox_alias_error' })
  }
}
