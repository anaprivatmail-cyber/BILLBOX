import PDFDocument from 'pdfkit'

import {
  jsonResponse,
  getUserFromAuthHeader,
  safeJsonBody,
  loadEntitlements,
  isExportAllowed,
  assertPayerScope,
  sanitizeFilename,
  buildBillQueryWithFilters,
  uploadAndSign,
} from './_exports.js'

async function listBillAttachmentsCount(supabase, userId, billId) {
  const dir = `${userId}/bills/${billId}`
  const { data, error } = await supabase.storage.from('attachments').list(dir, { limit: 1 })
  if (error || !Array.isArray(data)) return 0
  return data.length
}

function bufferFromPdf(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const chunks = []
    doc.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      build(doc)
      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

function money(amount, currency) {
  const n = typeof amount === 'number' ? amount : Number(amount || 0)
  const cur = String(currency || 'EUR')
  return `${cur} ${Number.isFinite(n) ? n.toFixed(2) : '0.00'}`
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
    const kind = String(body.kind || body.type || 'range') // 'range' | 'single'
    const spaceId = body.spaceId ? String(body.spaceId) : null
    const filters = body.filters || {}
    const billId = body.billId ? String(body.billId) : null

    const supabase = authInfo.supabase
    const userId = authInfo.userId

    const ent = await loadEntitlements(supabase, userId)
    if (!isExportAllowed(ent.plan, 'pdf')) {
      return jsonResponse(403, { ok: false, error: 'upgrade_required', code: 'upgrade_required' })
    }
    const payerCheck = assertPayerScope(ent, spaceId)
    if (!payerCheck.ok) {
      return jsonResponse(403, { ok: false, error: 'upgrade_required', code: payerCheck.code || 'upgrade_required' })
    }

    let bills = []
    let queryError = null

    if (kind === 'single') {
      if (!billId) {
        return jsonResponse(400, { ok: false, error: 'missing_bill_id', code: 'missing_bill_id' })
      }
      let q = supabase.from('bills').select('*').eq('user_id', userId).eq('id', billId).limit(1).maybeSingle()
      if (spaceId) q = q.eq('space_id', spaceId)
      const { data, error } = await q
      if (error || !data) {
        return jsonResponse(404, { ok: false, error: 'bill_not_found', code: 'bill_not_found' })
      }
      bills = [data]
    } else {
      const { query, hasAttachmentsOnly } = buildBillQueryWithFilters({ supabase, userId, spaceId, filters })
      const { data, error } = await query.order('due_date', { ascending: true })
      queryError = error || null
      bills = data || []

      if (!queryError && hasAttachmentsOnly && bills.length) {
        const kept = []
        for (const b of bills) {
          try {
            const count = await listBillAttachmentsCount(supabase, userId, b.id)
            if (count > 0) kept.push(b)
          } catch {
            // ignore
          }
        }
        bills = kept
      }
    }

    if (queryError) {
      return jsonResponse(500, { ok: false, error: 'query_failed', code: 'query_failed' })
    }

    const start = String(filters?.start || '')
    const end = String(filters?.end || '')
    const status = String(filters?.status || 'all')

    const pdfBuffer = await bufferFromPdf((doc) => {
      doc.fontSize(18).text('BillBox Export', { align: 'left' })
      doc.moveDown(0.5)
      doc.fontSize(10).fillColor('#444').text(`Generated: ${new Date().toISOString()}`)
      if (kind !== 'single') {
        doc.text(`Range: ${start || '—'} → ${end || '—'}`)
        doc.text(`Status: ${status}`)
        doc.text(`Bills: ${bills.length}`)
      }
      doc.moveDown(1)
      doc.fillColor('#000')

      if (kind === 'single') {
        const b = bills[0]
        doc.fontSize(14).text(String(b.supplier || 'Bill'), { underline: false })
        doc.moveDown(0.5)
        doc.fontSize(11)
        doc.text(`Amount: ${money(b.amount, b.currency)}`)
        doc.text(`Due: ${String(b.due_date || '—')}`)
        doc.text(`Status: ${String(b.status || '—')}`)
        if (b.iban) doc.text(`IBAN: ${String(b.iban)}`)
        if (b.reference) doc.text(`Reference: ${String(b.reference)}`)
        if (b.purpose) doc.text(`Purpose: ${String(b.purpose)}`)
        if (b.creditor_name) doc.text(`Creditor: ${String(b.creditor_name)}`)
        doc.moveDown(1)
      } else {
        // Simple table
        const col1 = 48
        const col2 = 310
        const col3 = 410
        let y = doc.y
        doc.fontSize(11).text('Supplier', col1, y)
        doc.text('Amount', col2, y)
        doc.text('Due / Status', col3, y)
        doc.moveTo(col1, y + 14).lineTo(560, y + 14).strokeColor('#ddd').stroke()
        y += 22

        doc.fontSize(10)
        for (const b of bills) {
          if (y > 760) {
            doc.addPage()
            y = 48
          }
          const supplier = String(b.supplier || '—')
          const amt = money(b.amount, b.currency)
          const due = String(b.due_date || '—')
          const st = String(b.status || '—')
          doc.text(supplier, col1, y, { width: col2 - col1 - 10 })
          doc.text(amt, col2, y, { width: col3 - col2 - 10 })
          doc.text(`${due} • ${st}`, col3, y)
          y += 16
        }
      }
    })

    const filename = sanitizeFilename(
      kind === 'single' ? `bill-${billId}.pdf` : `billbox-report-${start || 'range'}-${end || ''}.pdf`,
      'billbox-report.pdf'
    )

    const path = `${userId}/exports/${Date.now()}-${filename}`
    const uploaded = await uploadAndSign({
      supabase,
      bucket: 'attachments',
      path,
      buffer: pdfBuffer,
      contentType: 'application/pdf',
      expiresIn: 900,
    })

    if (!uploaded.ok) {
      return jsonResponse(500, { ok: false, error: uploaded.error || 'export_failed', code: uploaded.error || 'export_failed' })
    }

    return jsonResponse(200, {
      ok: true,
      url: uploaded.url,
      filename,
      contentType: 'application/pdf',
      sizeBytes: uploaded.sizeBytes,
    })
  } catch {
    return jsonResponse(500, { ok: false, error: 'export_pdf_error', code: 'export_pdf_error' })
  }
}
