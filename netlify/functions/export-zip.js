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

function detectBinaryKind(buf) {
  try {
    if (!buf || buf.length < 4) return 'other'
    // %PDF-
    if (buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return 'pdf'
    // PNG
    if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png'
    // JPEG
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg'
    // WEBP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP'
    ) return 'webp'
    return 'other'
  } catch {
    return 'other'
  }
}

function normalizeExportName(originalName, detectedKind) {
  const raw = String(originalName || '').trim() || 'attachment'
  const safe = sanitizeFilename(raw, 'attachment')
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(safe)
  if (hasExt) return safe
  if (detectedKind === 'pdf') return `${safe}.pdf`
  if (detectedKind === 'png') return `${safe}.png`
  if (detectedKind === 'jpg') return `${safe}.jpg`
  if (detectedKind === 'webp') return `${safe}.webp`
  return safe
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
    const attachmentTypesRaw = Array.isArray(body.attachmentTypes)
      ? body.attachmentTypes
      : Array.isArray(body.attachment_types)
        ? body.attachment_types
        : null
    const attachmentTypes = attachmentTypesRaw
      ? attachmentTypesRaw.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
      : []
    const exportPart = body.exportPart || null
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
    const lifecycle = String(ent.lifecycleStatus || ent.status || 'active').trim().toLowerCase()
    const requestedScope = spaceIds.length ? spaceIds : (spaceId ? [spaceId] : [])

    const allowDowngradeExport = lifecycle === 'downgrade_vec_to_moje'
    if (!isExportAllowed(ent, 'zip', { allowDowngradeExport })) {
      return jsonResponse(403, { ok: false, error: 'upgrade_required', code: 'upgrade_required' })
    }

    if (allowDowngradeExport) {
      const allowedSpaceId2 = ent.spaceId2 ? String(ent.spaceId2) : ''
      const onlySpace2 = requestedScope.length
        ? requestedScope.every((sid) => String(sid || '').trim() === allowedSpaceId2)
        : false
      if (!onlySpace2) {
        return jsonResponse(403, { ok: false, error: 'upgrade_required', code: 'upgrade_required' })
      }
    } else {
      const payerCheck = assertPayerScope(ent, requestedScope)
      if (!payerCheck.ok) {
        return jsonResponse(403, { ok: false, error: 'upgrade_required', code: payerCheck.code || 'upgrade_required' })
      }
    }

    const requestedSpaceIds = requestedScope

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

    const manifestRows = [
      ['bill_id', 'space_id', 'supplier', 'creditor_name', 'invoice_number', 'due_date', 'status', 'amount', 'currency', 'iban', 'reference', 'purpose', 'created_at', 'attachment_kind', 'source_path', 'zip_path'],
    ]
    const errorLines = []

    const isPdfName = (name) => /\.pdf$/i.test(String(name || ''))
    const isImageName = (name) => /\.(png|jpe?g|webp)$/i.test(String(name || ''))
    const wantsPdf = attachmentTypes.includes('pdf')
    const wantsImage = attachmentTypes.includes('image')

    function isAllowedByDetectedKind(detectedKind) {
      if (!attachmentTypes.length) return true
      if (wantsPdf && detectedKind === 'pdf') return true
      if (wantsImage && (detectedKind === 'png' || detectedKind === 'jpg' || detectedKind === 'webp')) return true
      return false
    }

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
          const detectedKind = (() => {
            if (!attachmentTypes.length) return detectBinaryKind(buf)
            const n = String(a.name || '')
            if (wantsPdf && isPdfName(n)) return 'pdf'
            if (wantsImage && isImageName(n)) {
              const lower = n.toLowerCase()
              if (lower.endsWith('.png')) return 'png'
              if (lower.endsWith('.webp')) return 'webp'
              return 'jpg'
            }
            return detectBinaryKind(buf)
          })()

          if (!isAllowedByDetectedKind(detectedKind)) continue

          const finalName = normalizeExportName(a.name, detectedKind)
          const entryName = ensureUniqueName(seenNames, `${baseDir}/${finalName}`)
          archive.append(buf, { name: entryName })
          manifestRows.push([
            String(bill.id),
            String(bill.space_id || ''),
            String(bill.supplier || ''),
            String(bill.creditor_name || ''),
            String(bill.invoice_number || ''),
            String(bill.due_date || ''),
            String(bill.status || ''),
            String(bill.amount ?? ''),
            String(bill.currency ?? ''),
            String(bill.iban || ''),
            String(bill.reference || ''),
            String(bill.purpose || ''),
            String(bill.created_at || ''),
            'bill',
            String(a.path),
            String(entryName),
          ])
        } catch {
          errorLines.push(`bill:${bill.id} ${a.path}`)
        }
      }

      const w = warrantyByBillId.get(bill.id) || null
      if (w?.id) {
        const wAtt = await listAttachments(supabase, userId, 'warranties', w.id)
        for (const a of wAtt) {
          try {
            const buf = await downloadAttachment(supabase, a.path)

            const detectedKind = (() => {
              if (!attachmentTypes.length) return detectBinaryKind(buf)
              const n = String(a.name || '')
              if (wantsPdf && isPdfName(n)) return 'pdf'
              if (wantsImage && isImageName(n)) {
                const lower = n.toLowerCase()
                if (lower.endsWith('.png')) return 'png'
                if (lower.endsWith('.webp')) return 'webp'
                return 'jpg'
              }
              return detectBinaryKind(buf)
            })()

            if (!isAllowedByDetectedKind(detectedKind)) continue

            const finalName = normalizeExportName(a.name, detectedKind)
            const entryName = ensureUniqueName(seenNames, `${baseDir}/warranty/${finalName}`)
            archive.append(buf, { name: entryName })
            manifestRows.push([
              String(bill.id),
              String(bill.space_id || ''),
              String(bill.supplier || ''),
              String(bill.creditor_name || ''),
              String(bill.invoice_number || ''),
              String(bill.due_date || ''),
              String(bill.status || ''),
              String(bill.amount ?? ''),
              String(bill.currency ?? ''),
              String(bill.iban || ''),
              String(bill.reference || ''),
              String(bill.purpose || ''),
              String(bill.created_at || ''),
              'warranty',
              String(a.path),
              String(entryName),
            ])
          } catch {
            errorLines.push(`warranty:${w.id} bill:${bill.id} ${a.path}`)
          }
        }
      }
    }

    // Always include a manifest for accounting/debugging.
    const csvEscape = (v) => {
      const s = v === null || v === undefined ? '' : String(v)
      return `"${s.replace(/"/g, '""')}"`
    }
    const manifestCsv = manifestRows.map((r) => r.map(csvEscape).join(',')).join('\n')
    archive.append(Buffer.from(manifestCsv, 'utf8'), { name: 'manifest.csv' })
    if (errorLines.length) {
      archive.append(Buffer.from(errorLines.join('\n'), 'utf8'), { name: 'errors.txt' })
    }
    if (manifestRows.length === 1) {
      const note = attachmentTypes.length
        ? `No attachments matched the requested types (${attachmentTypes.join(', ')}).\n\nTry exporting with type=all.`
        : 'No attachments were found for the selected bills/range.'
      archive.append(Buffer.from(note, 'utf8'), { name: 'README.txt' })
    }

    await archive.finalize()
    const zipBuffer = await streamToBuffer(out)

    const start = String(filters?.start || '')
    const end = String(filters?.end || '')
    const selectionLabel = billIds.length ? `selection-${filteredBills.length}` : `${start || 'range'}-${end || ''}`
    const partSuffix = exportPart?.index && exportPart?.count ? `-part-${exportPart.index}-of-${exportPart.count}` : ''
    const filename = sanitizeFilename(`billbox-attachments-${selectionLabel}${partSuffix}.zip`, 'billbox-attachments.zip')
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
