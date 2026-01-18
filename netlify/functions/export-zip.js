import archiver from 'archiver'
import { PassThrough } from 'node:stream'

import {
  jsonResponse,
  getUserFromAuthHeader,
  safeJsonBody,
  loadEntitlements,
  isExportAllowed,
  assertPayerScope,
  sanitizeFilename,
  sanitizePathSegment,
  buildBillQueryWithFilters,
  uploadAndSign,
} from './_exports.js'

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function listAttachments(supabase, userId, kind, recId) {
  const dir = `${userId}/${kind}/${recId}`
  const { data, error } = await supabase.storage.from('attachments').list(dir, {
    limit: 100,
    sortBy: { column: 'name', order: 'asc' },
  })
  if (error || !Array.isArray(data)) return []
  return data.map((f) => ({ name: f.name, path: `${dir}/${f.name}` }))
}

async function downloadAttachment(supabase, path) {
  const { data, error } = await supabase.storage.from('attachments').download(path)
  if (error || !data) throw new Error(error?.message || 'download_failed')
  const ab = await data.arrayBuffer()
  return Buffer.from(ab)
}

function ensureUniqueName(seen, name) {
  if (!seen.has(name)) {
    seen.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 2
  while (seen.has(`${base} (${i})${ext}`)) i += 1
  const next = `${base} (${i})${ext}`
  seen.add(next)
  return next
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const authInfo = await getUserFromAuthHeader(event)
    if (!authInfo.userId || !authInfo.supabase) {
      return jsonResponse(401, { ok: false, error: 'auth_required', code: 'auth_required' })
    }

    const body = await safeJsonBody(event)
    const spaceId = body.spaceId ? String(body.spaceId) : null
    const spaceIdsRaw = Array.isArray(body.spaceIds)
      ? body.spaceIds
      : Array.isArray(body.space_ids)
        ? body.space_ids
        : null
    const spaceIds = spaceIdsRaw
      ? spaceIdsRaw.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 5)
      : []
    const filters = body.filters || {}
    const billIdsRaw = Array.isArray(body.billIds)
      ? body.billIds
      : Array.isArray(body.bill_ids)
        ? body.bill_ids
        : null
    const billIds = billIdsRaw
      ? billIdsRaw
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .slice(0, 500)
      : []

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const ent = await loadEntitlements(supabase, userId)
    if (!isExportAllowed(ent.plan, 'zip')) {
      return jsonResponse(403, { ok: false, error: 'upgrade_required', code: 'upgrade_required' })
    }
    const payerCheck = assertPayerScope(ent, spaceIds.length ? spaceIds : spaceId)
    if (!payerCheck.ok) {
      return jsonResponse(403, { ok: false, error: 'upgrade_required', code: payerCheck.code || 'upgrade_required' })
    }

    const requestedSpaceIds = spaceIds.length ? spaceIds : (spaceId ? [spaceId] : [])

    let billList = []
    let hasAttachmentsOnly = false
    if (billIds.length) {
      let q = supabase.from('bills').select('*').eq('user_id', userId).in('id', billIds)
      if (requestedSpaceIds.length === 1) q = q.eq('space_id', requestedSpaceIds[0])
      else if (requestedSpaceIds.length > 1) q = q.in('space_id', requestedSpaceIds)
      const { data, error } = await q
      if (error) {
        return jsonResponse(500, { ok: false, error: 'query_failed', code: 'query_failed' })
      }
      billList = data || []
      hasAttachmentsOnly = Boolean(filters?.hasAttachmentsOnly)
    } else {
      const built = buildBillQueryWithFilters({ supabase, userId, spaceId, spaceIds: requestedSpaceIds, filters })
      hasAttachmentsOnly = Boolean(built.hasAttachmentsOnly)
      const { data: bills, error } = await built.query.order('due_date', { ascending: true })
      if (error) {
        return jsonResponse(500, { ok: false, error: 'query_failed', code: 'query_failed' })
      }
      billList = bills || []
    }

    if (!billList.length) {
      return jsonResponse(400, { ok: false, error: 'no_bills', code: 'no_bills' })
    }

    // Resolve linked warranties for these bills
    const billIdList = billList.map((b) => b.id)
    let warranties = []
    try {
      let wq = supabase.from('warranties').select('*').eq('user_id', userId)
      if (requestedSpaceIds.length === 1) wq = wq.eq('space_id', requestedSpaceIds[0])
      else if (requestedSpaceIds.length > 1) wq = wq.in('space_id', requestedSpaceIds)
      if (billIdList.length) wq = wq.in('bill_id', billIdList)
      const { data } = await wq
      warranties = data || []
    } catch {
      warranties = []
    }

    const warrantyByBillId = new Map()
    for (const w of warranties) {
      const bid = w?.bill_id
      if (bid && !warrantyByBillId.has(bid)) warrantyByBillId.set(bid, w)
    }

    const filteredBills = []
    if (hasAttachmentsOnly) {
      // Match app behavior: hasAttachment filters by BILL attachments count.
      for (const b of billList) {
        const list = await listAttachments(supabase, userId, 'bills', b.id)
        if (list.length > 0) filteredBills.push(b)
      }
    } else {
      filteredBills.push(...billList)
    }

    if (!filteredBills.length) {
      return jsonResponse(400, { ok: false, error: 'no_bills', code: 'no_bills' })
    }

    const archive = archiver('zip', { zlib: { level: 9 } })
    const out = new PassThrough()
    archive.pipe(out)

    const seenNames = new Set()

    for (const bill of filteredBills) {
      const due = String(bill.due_date || '')
      const year = due.slice(0, 4) || 'unknown'
      const month = due.slice(5, 7) || '00'
      const supplier = sanitizePathSegment(bill.supplier || 'supplier')
      const baseDir = `${year}/${month}/${supplier}`

      const billAtt = await listAttachments(supabase, userId, 'bills', bill.id)
      for (const a of billAtt) {
        try {
          const buf = await downloadAttachment(supabase, a.path)
          const entryName = ensureUniqueName(seenNames, `${baseDir}/${sanitizeFilename(a.name, 'attachment')}`)
          archive.append(buf, { name: entryName })
        } catch {
          // Skip failed files; ZIP still returns.
        }
      }

      const w = warrantyByBillId.get(bill.id) || null
      if (w?.id) {
        const wAtt = await listAttachments(supabase, userId, 'warranties', w.id)
        for (const a of wAtt) {
          try {
            const buf = await downloadAttachment(supabase, a.path)
            const entryName = ensureUniqueName(seenNames, `${baseDir}/warranty/${sanitizeFilename(a.name, 'attachment')}`)
            archive.append(buf, { name: entryName })
          } catch {
            // Skip failed files
          }
        }
      }
    }

    await archive.finalize()
    const zipBuffer = await streamToBuffer(out)

    const start = String(filters?.start || '')
    const end = String(filters?.end || '')
    const selectionLabel = billIds.length ? `selection-${filteredBills.length}` : `${start || 'range'}-${end || ''}`
    const filename = sanitizeFilename(`billbox-attachments-${selectionLabel}.zip`, 'billbox-attachments.zip')
    const path = `${userId}/exports/${Date.now()}-${filename}`

    const uploaded = await uploadAndSign({
      supabase,
      bucket: 'attachments',
      path,
      buffer: zipBuffer,
      contentType: 'application/zip',
      expiresIn: 900,
    })

    if (!uploaded.ok) {
      return jsonResponse(500, { ok: false, error: uploaded.error || 'export_failed', code: uploaded.error || 'export_failed' })
    }

    return jsonResponse(200, {
      ok: true,
      url: uploaded.url,
      filename,
      contentType: 'application/zip',
      sizeBytes: uploaded.sizeBytes,
    })
  } catch {
    return jsonResponse(500, { ok: false, error: 'export_zip_error', code: 'export_zip_error' })
  }
}
