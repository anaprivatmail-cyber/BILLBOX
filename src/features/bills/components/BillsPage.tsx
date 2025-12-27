import { useEffect, useMemo, useState } from 'react'
import type { Bill, BillFilter } from '../types'
import { listBills, createBill, updateBill, deleteBill, setBillStatus, isOverdue } from '../api'
import { listAttachments, uploadAttachments, deleteAttachment, getDownloadUrl } from '../attachments'
import BillForm from './BillForm'

export default function BillsPage() {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<BillFilter>('all')
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Bill | null>(null)
  const [openAttachmentsFor, setOpenAttachmentsFor] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Record<string, { items: { name: string; path: string }[]; loading: boolean; error: string | null }>>({})

  async function reload() {
    setLoading(true)
    const { data, error } = await listBills()
    if (error) setError(error.message)
    else setBills(data)
    setLoading(false)
  }
  async function loadAttachments(billId: string) {
    setAttachments((prev) => ({
      ...prev,
      [billId]: { items: prev[billId]?.items || [], loading: true, error: null },
    }))
    const { items, error } = await listAttachments(billId)
    setAttachments((prev) => ({
      ...prev,
      [billId]: { items, loading: false, error: error ? (error as any)?.message || 'Failed to list' : null },
    }))
  }

  async function handleUploadFiles(billId: string, files: FileList | null) {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    const { error } = await uploadAttachments(billId, arr)
    if (error) {
      setAttachments((prev) => ({
        ...prev,
        [billId]: { items: prev[billId]?.items || [], loading: false, error: (error as any)?.message || 'Upload failed' },
      }))
    } else {
      await loadAttachments(billId)
    }
  }

  async function handleDeleteAttachment(billId: string, path: string) {
    const { error } = await deleteAttachment(path)
    if (error) {
      setAttachments((prev) => ({
        ...prev,
        [billId]: { items: prev[billId]?.items || [], loading: false, error: (error as any)?.message || 'Delete failed' },
      }))
    } else {
      await loadAttachments(billId)
    }
  }

  async function handleOpenAttachment(path: string) {
    const { url } = await getDownloadUrl(path)
    if (url) window.open(url, '_blank')
  }

  useEffect(() => {
    reload()
  }, [])

  const filtered = useMemo(() => {
    let items = bills.slice()
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      items = items.filter((b) => b.supplier.toLowerCase().includes(q))
    }
    items = items.sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
    if (filter === 'unpaid') items = items.filter((b) => b.status === 'unpaid')
    else if (filter === 'paid') items = items.filter((b) => b.status === 'paid')
    else if (filter === 'overdue') items = items.filter((b) => isOverdue(b))
    return items
  }, [bills, filter, query])

  const analytics = useMemo(() => {
    const unpaid = bills.filter((b) => b.status === 'unpaid')
    const overdue = bills.filter((b) => isOverdue(b))
    const sum = (arr: Bill[]) => arr.reduce((acc, b) => acc + (Number(b.amount) || 0), 0)
    const nextDue = bills
      .filter((b) => b.status !== 'paid')
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null
    return {
      unpaidCount: unpaid.length,
      unpaidTotal: sum(unpaid),
      overdueCount: overdue.length,
      overdueTotal: sum(overdue),
      nextDue,
    }
  }, [bills])

  async function handleSave(input: { supplier: string; amount: number; currency: string; due_date: string }, id?: string) {
    if (id) {
      const { error } = await updateBill(id, input)
      if (error) setError(error.message)
    } else {
      const { error } = await createBill({ ...input, status: 'unpaid' })
      if (error) setError(error.message)
    }
    setFormOpen(false)
    setEditing(null)
    reload()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this bill? This cannot be undone.')) return
    const { error } = await deleteBill(id)
    if (error) setError(error.message)
    reload()
  }

  async function handleMark(id: string, status: 'paid' | 'unpaid') {
    const { error } = await setBillStatus(id, status)
    if (error) setError(error.message)
    reload()
  }

  return (
    <div style={{ padding: 12, maxWidth: 640, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 8 }}>Bills</h2>
      <div style={{ background: '#f6f7f9', padding: 8, borderRadius: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <strong>Unpaid:</strong> {analytics.unpaidCount} / {analytics.unpaidTotal.toFixed(2)}
          </div>
          <div>
            <strong>Overdue:</strong> {analytics.overdueCount} / {analytics.overdueTotal.toFixed(2)}
          </div>
          {analytics.nextDue && (
            <div>
              <strong>Next due:</strong> {analytics.nextDue.supplier} on {analytics.nextDue.due_date} ({analytics.nextDue.amount} {analytics.nextDue.currency})
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'unpaid', 'paid', 'overdue'] as BillFilter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ fontWeight: filter === f ? 'bold' as const : 'normal' }}>{f.toUpperCase()}</button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search supplier"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button onClick={() => { setFormOpen(true); setEditing(null) }}>Add bill</button>
      </div>

      {error && <p style={{ color: 'red', marginTop: 8 }}>{error}</p>}
      {loading ? (
        <p style={{ marginTop: 12 }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ marginTop: 12 }}>
          No bills found. Try adding a bill using the button above. You can track unpaid and overdue items here.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {filtered.map((b) => {
            const overdue = isOverdue(b)
            return (
              <li key={b.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{b.supplier}</div>
                    <div style={{ fontSize: 12, color: '#555' }}>{b.amount} {b.currency} • due {b.due_date}</div>
                    <div style={{ fontSize: 12, color: overdue ? 'red' : b.status === 'paid' ? 'green' : '#555' }}>
                      {overdue ? 'overdue' : b.status}
                    </div>
                    <div style={{ fontSize: 11, color: '#999' }}>Created at {new Date(b.created_at).toLocaleString()}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {b.status === 'paid' ? (
                      <button onClick={() => handleMark(b.id, 'unpaid')}>Mark unpaid</button>
                    ) : (
                      <button onClick={() => handleMark(b.id, 'paid')}>Mark paid</button>
                    )}
                    <button onClick={() => { setEditing(b); setFormOpen(true) }}>Edit</button>
                    <button onClick={() => handleDelete(b.id)}>Delete</button>
                    <button onClick={async () => {
                      const next = openAttachmentsFor === b.id ? null : b.id
                      setOpenAttachmentsFor(next)
                      if (next) await loadAttachments(next)
                    }}>
                      {openAttachmentsFor === b.id ? 'Hide files' : 'Attachments'}
                    </button>
                  </div>
                </div>
                {openAttachmentsFor === b.id && (
                  <div style={{ marginTop: 8, borderTop: '1px dashed #ddd', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => handleUploadFiles(b.id, e.target.files)} />
                      <span style={{ fontSize: 12, color: '#666' }}>Upload PDF or images</span>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {attachments[b.id]?.loading ? (
                        <div style={{ fontSize: 12 }}>Loading files…</div>
                      ) : attachments[b.id]?.error ? (
                        <div style={{ fontSize: 12, color: 'red' }}>{attachments[b.id]?.error}</div>
                      ) : (attachments[b.id]?.items || []).length === 0 ? (
                        <div style={{ fontSize: 12, color: '#666' }}>No attachments yet.</div>
                      ) : (
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                          {(attachments[b.id]?.items || []).map((f) => (
                            <li key={f.path} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 12 }}>{f.name}</span>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => handleOpenAttachment(f.path)}>Open</button>
                                <button onClick={() => handleDeleteAttachment(b.id, f.path)}>Delete</button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: 8 }}>
            <BillForm
              initial={editing}
              onCancel={() => { setFormOpen(false); setEditing(null) }}
              onSave={handleSave}
            />
          </div>
        </div>
      )}
    </div>
  )
}
