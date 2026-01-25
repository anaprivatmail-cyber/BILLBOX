import { createClient } from '@supabase/supabase-js'
import Busboy from 'busboy'
import { Readable } from 'node:stream'

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

function normalizeSpaceId(v) {
  const s = String(v || '').trim()
  return s ? s : 'default'
}

function safeString(v) {
  const s = v === null || v === undefined ? '' : String(v)
  const t = s.trim()
  return t ? t : null
}

function truncateText(value, max = 4000) {
  const s = String(value || '')
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

function stripHtml(input) {
  const raw = String(input || '')
  if (!raw) return ''
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTokenFromRecipient(addr) {
  const s = String(addr || '').trim()
  if (!s) return null
  const m = s.match(/<?([^\s<>]+@[^\s<>]+)>?/) // extract address if in "Name <a@b>"
  const email = (m ? m[1] : s).toLowerCase()
  const local = email.split('@')[0] || ''
  const plus = local.lastIndexOf('+')
  const token = plus >= 0 ? local.slice(plus + 1) : local
  const cleaned = token.trim()
  if (!cleaned) return null
  return cleaned
}

function collectRecipients(payload) {
  const out = []
  const pushAny = (v) => {
    if (!v) return
    if (Array.isArray(v)) {
      for (const it of v) pushAny(it)
      return
    }
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'object') {
      if (typeof v.email === 'string') out.push(v.email)
      if (typeof v.address === 'string') out.push(v.address)
      if (typeof v.value === 'string') out.push(v.value)
    }
  }

  pushAny(payload.to)
  pushAny(payload.recipient)
  pushAny(payload.recipients)
  pushAny(payload.envelope?.to)
  pushAny(payload.envelope?.rcpt_to)

  return out
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 20)
}

function collectAttachments(payload) {
  const raw =
    (Array.isArray(payload.attachments) && payload.attachments) ||
    (Array.isArray(payload.attachment) && payload.attachment) ||
    (Array.isArray(payload.files) && payload.files) ||
    []

  const out = []
  for (const a of raw) {
    if (!a) continue
    const filename = safeString(a.filename || a.name || a.fileName || a.originalname) || 'document'
    let mimeType = safeString(a.contentType || a.type || a.mimeType || a.mimetype) || 'application/octet-stream'
    if (mimeType === 'application/octet-stream' && /\.csv$/i.test(filename)) {
      mimeType = 'text/csv'
    }
    const base64 = safeString(a.content || a.data || a.base64 || a.content_base64)
    const sizeBytes =
      typeof a.size === 'number'
        ? a.size
        : typeof a.sizeBytes === 'number'
          ? a.sizeBytes
          : base64
            ? Math.floor((base64.length * 3) / 4)
            : null

    if (!base64) continue
    out.push({ filename, mimeType, base64, sizeBytes })
  }
  return out.slice(0, 10)
}

function sanitizeFilename(name) {
  const s = String(name || 'document')
  const base = s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'document'
  return base
}

function isAllowedMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return true
  if (m === 'application/pdf') return true
  if (m === 'text/csv' || m === 'application/csv' || m === 'application/vnd.ms-excel') return true
  return false
}

function looksLikeMultipart(contentType) {
  const ct = String(contentType || '').toLowerCase()
  return ct.includes('multipart/form-data')
}

async function parseMultipartForm(event, { maxBytes } = {}) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || ''
  if (!looksLikeMultipart(contentType)) return { fields: {}, files: [] }

  const bodyBuf = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8')
  const bb = Busboy({ headers: { 'content-type': contentType } })

  const fields = {}
  const files = []
  let totalFileBytes = 0

  const done = new Promise((resolve, reject) => {
    bb.on('field', (name, val) => {
      const key = String(name || '').trim()
      if (!key) return
      // Keep first value if duplicates are present.
      if (fields[key] === undefined) fields[key] = val
    })

    bb.on('file', (name, fileStream, info) => {
      const filename = safeString(info?.filename) || 'document'
      const mimeType = safeString(info?.mimeType) || 'application/octet-stream'

      const chunks = []
      let size = 0
      let exceeded = false

      fileStream.on('data', (chunk) => {
        if (exceeded) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buf.length
        totalFileBytes += buf.length

        if (typeof maxBytes === 'number' && maxBytes > 0) {
          if (size > maxBytes || totalFileBytes > maxBytes) {
            exceeded = true
            chunks.length = 0
            fileStream.resume()
            return
          }
        }
        chunks.push(buf)
      })

      fileStream.on('end', () => {
        // Only keep files that have non-trivial size.
        if (!exceeded && size >= 16) {
          files.push({ fieldName: name, filename, mimeType, buffer: Buffer.concat(chunks), sizeBytes: size })
        }
      })

      fileStream.on('error', reject)
    })

    bb.on('error', reject)
    bb.on('finish', () => resolve())
  })

  Readable.from(bodyBuf).pipe(bb)
  await done

  return { fields, files }
}

async function parseInboundPayload(event) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || ''
  const maxBytes = Number(process.env.INBOUND_EMAIL_MAX_BYTES || 12 * 1024 * 1024)

  if (looksLikeMultipart(contentType)) {
    const { fields, files } = await parseMultipartForm(event, { maxBytes })

    // Mailgun inbound (routes/forward) sends multipart/form-data.
    // Docs/fields can vary: "recipient", "To", "sender", "from", "subject",
    // "stripped-text", "body-plain", "stripped-html", "body-html", etc.
    const payload = {
      provider: 'mailgun',
      recipient: fields.recipient || fields.Recipient || fields.to || fields.To || fields.TO || null,
      to: fields.to || fields.To || null,
      recipients: fields.recipients || null,
      from: fields.sender || fields.from || fields.From || null,
      sender: fields.sender || null,
      subject: fields.subject || fields.Subject || null,
      date: fields.Date || fields.date || null,
      messageId: fields['Message-Id'] || fields['message-id'] || fields['message_id'] || null,
      'message-id': fields['Message-Id'] || fields['message-id'] || fields['message_id'] || null,
      'stripped-text': fields['stripped-text'] || fields['stripped_text'] || null,
      'stripped-html': fields['stripped-html'] || fields['stripped_html'] || null,
      text: fields.text || fields['body-plain'] || fields['body_plain'] || null,
      html: fields.html || fields['body-html'] || fields['body_html'] || null,
      attachments: files.map((f) => ({
        filename: f.filename,
        contentType: f.mimeType,
        content: f.buffer.toString('base64'),
        size: f.sizeBytes,
      })),
    }

    return payload
  }

  let payload = {}
  try {
    payload = JSON.parse(event.body || '{}')
  } catch {
    payload = {}
  }
  return payload
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const expected = String(process.env.INBOUND_EMAIL_SECRET || '').trim()
    if (!expected) {
      return jsonResponse(500, { ok: false, error: 'inbound_not_configured' })
    }

    const provided =
      (event.headers['x-billbox-inbound-secret'] || event.headers['X-Billbox-Inbound-Secret'] || '').trim() ||
      (event.queryStringParameters?.secret || event.queryStringParameters?.token || '').trim()

    if (!provided || provided !== expected) {
      // Return 401 to surface misconfiguration; Brevo can be configured with a secret header/query.
      return jsonResponse(401, { ok: false, error: 'unauthorized' })
    }

    const payload = await parseInboundPayload(event)

    const recipients = collectRecipients(payload)
    const overrideToken = (event.headers['x-billbox-alias-token'] || event.headers['X-Billbox-Alias-Token'] || '').trim()

    const tokens = []
    if (overrideToken) tokens.push(overrideToken)
    for (const r of recipients) {
      const tok = parseTokenFromRecipient(r)
      if (tok) tokens.push(tok)
    }

    const aliasToken = tokens.length ? String(tokens[0]) : null
    if (!aliasToken) {
      return jsonResponse(200, { ok: false, error: 'missing_alias_token' })
    }

    const supabase = getSupabaseAdmin()
    if (!supabase) {
      return jsonResponse(500, { ok: false, error: 'supabase_admin_not_configured' })
    }

    const { data: aliasRow, error: aliasErr } = await supabase
      .from('inbound_email_aliases')
      .select('user_id, space_id, active')
      .eq('alias_token', aliasToken)
      .limit(1)
      .maybeSingle()

    if (aliasErr) {
      return jsonResponse(500, { ok: false, error: 'alias_query_failed', detail: aliasErr.message })
    }
    if (!aliasRow || !aliasRow.user_id || !aliasRow.space_id || aliasRow.active === false) {
      return jsonResponse(200, { ok: false, error: 'alias_not_found' })
    }

    const userId = String(aliasRow.user_id)
    const spaceId = normalizeSpaceId(aliasRow.space_id)

    const sender = safeString(payload.from || payload.sender || payload.envelope?.from)
    const subject = safeString(payload.subject)

    const bodyTextRaw =
      payload.text ||
      payload.text_body ||
      payload.textBody ||
      payload['stripped-text'] ||
      payload['stripped_text'] ||
      payload.body ||
      ''
    const bodyHtmlRaw =
      payload.html ||
      payload.html_body ||
      payload.htmlBody ||
      payload['stripped-html'] ||
      payload['stripped_html'] ||
      ''
    const bodyText = truncateText(bodyTextRaw)
    const bodyHtml = truncateText(bodyHtmlRaw)
    const bodyFromHtml = bodyHtml ? truncateText(stripHtml(bodyHtml), 4000) : null

    const receivedAt = safeString(payload.date || payload.received_at || payload.receivedAt)
    const receivedIso = receivedAt && !Number.isNaN(new Date(receivedAt).getTime()) ? new Date(receivedAt).toISOString() : new Date().toISOString()

    const attachments = collectAttachments(payload)
    if (!attachments.length) {
      return jsonResponse(200, { ok: true, userId, spaceId, created: 0, skipped: 0 })
    }

    const maxBytes = Number(process.env.INBOUND_EMAIL_MAX_BYTES || 12 * 1024 * 1024)
    let created = 0
    let skipped = 0

    for (const att of attachments) {
      try {
        const size = typeof att.sizeBytes === 'number' ? att.sizeBytes : null
        if (size !== null && size > maxBytes) {
          skipped += 1
          continue
        }
        if (!isAllowedMime(att.mimeType)) {
          skipped += 1
          continue
        }

        const { data: inboxItem, error: insErr } = await supabase
          .from('inbox_items')
          .insert({
            user_id: userId,
            space_id: spaceId,
            source: 'email',
            status: 'pending',
            sender,
            subject,
            received_at: receivedIso,
            attachment_bucket: 'attachments',
            attachment_name: att.filename,
            mime_type: att.mimeType,
            size_bytes: size,
            meta: {
              provider: payload.provider || 'brevo',
              message_id: payload.messageId || payload['message-id'] || payload.message_id || null,
              recipients,
              body_text: bodyText || bodyFromHtml || null,
              body_html: bodyHtml || null,
            },
          })
          .select('id')
          .single()

        if (insErr || !inboxItem?.id) {
          skipped += 1
          continue
        }

        const inboxId = String(inboxItem.id)
        const safeName = sanitizeFilename(att.filename)
        const path = `${userId}/inbox/${inboxId}/${safeName}`

        const buf = Buffer.from(att.base64, 'base64')
        if (buf.length < 16) {
          skipped += 1
          continue
        }
        if (buf.length > maxBytes) {
          skipped += 1
          continue
        }

        const { error: upErr } = await supabase
          .storage
          .from('attachments')
          .upload(path, buf, { upsert: true, contentType: att.mimeType })

        if (upErr) {
          skipped += 1
          continue
        }

        await supabase
          .from('inbox_items')
          .update({ attachment_path: path, size_bytes: buf.length })
          .eq('id', inboxId)

        created += 1
      } catch {
        skipped += 1
      }
    }

    return jsonResponse(200, { ok: true, userId, spaceId, created, skipped })
  } catch {
    return jsonResponse(500, { ok: false, error: 'email_inbox_error' })
  }
}
