import { createClient } from '@supabase/supabase-js'

const GRACE_DAYS = 30
const EXPORT_ONLY_DAYS = 30

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

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

async function listAllInDir(supabase, bucket, dir) {
  const { data, error } = await supabase.storage.from(bucket).list(dir, { limit: 1000 })
  if (error || !Array.isArray(data)) return []
  return data.map((f) => `${dir}/${f.name}`)
}

async function deleteStorageDir(supabase, bucket, dir) {
  if (!dir) return
  try {
    const paths = await listAllInDir(supabase, bucket, dir)
    if (paths.length) {
      await supabase.storage.from(bucket).remove(paths)
    }
  } catch {
    // ignore storage errors to avoid blocking cleanup
  }
}

async function cleanupProfileAttachments(supabase, userId, spaceId) {
  if (!spaceId) return

  const bills = await supabase
    .from('bills')
    .select('id')
    .eq('user_id', userId)
    .eq('space_id', spaceId)

  const warranties = await supabase
    .from('warranties')
    .select('id')
    .eq('user_id', userId)
    .eq('space_id', spaceId)

  const billIds = (bills.data || []).map((b) => b.id)
  const warrantyIds = (warranties.data || []).map((w) => w.id)

  for (const id of billIds) {
    await deleteStorageDir(supabase, 'attachments', `${userId}/bills/${id}`)
  }

  for (const id of warrantyIds) {
    await deleteStorageDir(supabase, 'attachments', `${userId}/warranties/${id}`)
  }

  await supabase.from('bills').delete().eq('user_id', userId).eq('space_id', spaceId)
  await supabase.from('warranties').delete().eq('user_id', userId).eq('space_id', spaceId)
  await supabase.from('inbox_items').delete().eq('user_id', userId).eq('space_id', spaceId)
}

async function cleanupAllAttachments(supabase, userId) {
  const bills = await supabase.from('bills').select('id').eq('user_id', userId)
  const warranties = await supabase.from('warranties').select('id').eq('user_id', userId)

  const billIds = (bills.data || []).map((b) => b.id)
  const warrantyIds = (warranties.data || []).map((w) => w.id)

  for (const id of billIds) {
    await deleteStorageDir(supabase, 'attachments', `${userId}/bills/${id}`)
  }

  for (const id of warrantyIds) {
    await deleteStorageDir(supabase, 'attachments', `${userId}/warranties/${id}`)
  }

  await deleteStorageDir(supabase, 'attachments', `${userId}/exports`)

  await supabase.from('bills').delete().eq('user_id', userId)
  await supabase.from('warranties').delete().eq('user_id', userId)
  await supabase.from('inbox_items').delete().eq('user_id', userId)
}

export async function handler() {
  try {
    const supabase = getSupabaseAdmin()
    if (!supabase) return jsonResponse(500, { ok: false, error: 'supabase_not_configured' })

    const { data: rows } = await supabase
      .from('entitlements')
      .select('*')
      .or('status.eq.grace_period,status.eq.export_only,status.eq.downgrade_vec_to_moje,status.eq.deleted,status.eq.cancelled_all,export_until.not.is.null,delete_at.not.is.null,downgrade_cleanup_at.not.is.null')
      .limit(1000)

    const now = new Date()
    let updated = 0
    let cleaned = 0

    for (const row of rows || []) {
      const userId = row.user_id
      const status = String(row.status || '').trim().toLowerCase()
      const graceUntil = row.grace_until ? new Date(row.grace_until) : null
      const exportUntil = row.export_until ? new Date(row.export_until) : null
      const deleteAt = row.delete_at ? new Date(row.delete_at) : null
      const downgradeCleanupAt = row.downgrade_cleanup_at ? new Date(row.downgrade_cleanup_at) : null
      const activeUntil = row.active_until ? new Date(row.active_until) : null

      if (status === 'cancelled_all') {
        if (activeUntil && now < activeUntil) continue
        const graceEnd = addDays(now, GRACE_DAYS)
        const exportEnd = addDays(graceEnd, EXPORT_ONLY_DAYS)
        await supabase.from('entitlements').update({
          status: 'grace_period',
          grace_until: graceEnd.toISOString(),
          export_until: exportEnd.toISOString(),
          delete_at: exportEnd.toISOString(),
          export_only: false,
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        updated += 1
        continue
      }

      if (deleteAt && now >= deleteAt) {
        await cleanupAllAttachments(supabase, userId)
        await supabase.from('entitlements').update({
          status: 'deleted',
          export_only: false,
          deleted_at: now.toISOString(),
          exports_enabled: false,
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        cleaned += 1
        continue
      }

      if (status === 'deleted' && !row.deleted_at) {
        await cleanupAllAttachments(supabase, userId)
        await supabase.from('entitlements').update({
          deleted_at: now.toISOString(),
          exports_enabled: false,
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        cleaned += 1
        continue
      }

      if (status === 'export_only' && exportUntil && now > exportUntil) {
        await cleanupAllAttachments(supabase, userId)
        await supabase.from('entitlements').update({
          status: 'deleted',
          export_only: false,
          deleted_at: now.toISOString(),
          exports_enabled: false,
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        cleaned += 1
        continue
      }

      if (status === 'grace_period' && graceUntil && now > graceUntil) {
        const nextExportUntil = exportUntil || addDays(now, EXPORT_ONLY_DAYS)
        await supabase.from('entitlements').update({
          status: 'export_only',
          export_only: true,
          exports_enabled: true,
          export_until: nextExportUntil.toISOString(),
          delete_at: row.delete_at || nextExportUntil.toISOString(),
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        updated += 1
        continue
      }

      if (status === 'downgrade_vec_to_moje' && downgradeCleanupAt && now > downgradeCleanupAt) {
        await cleanupProfileAttachments(supabase, userId, row.space_id2 || row.space_id_2 || null)
        await supabase.from('entitlements').update({
          status: 'active_moje',
          downgrade_cleanup_at: null,
          updated_at: now.toISOString(),
        }).eq('user_id', userId)
        cleaned += 1
      }
    }

    return jsonResponse(200, { ok: true, updated, cleaned })
  } catch (err) {
    return jsonResponse(500, { ok: false, error: 'cleanup_failed', detail: err?.message || 'cleanup_failed' })
  }
}
