import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Bill, BillFilter } from '../types'
import { listBills, createBill, updateBill, deleteBill, setBillStatus, isOverdue } from '../api'
import { listAttachments, uploadAttachments, deleteAttachment, getDownloadUrl } from '../attachments'
import { Link, useLocation } from 'react-router-dom'
import Card from '../../../components/ui/Card'
import Button from '../../../components/ui/Button'
import Input from '../../../components/ui/Input'
import Badge from '../../../components/ui/Badge'
import { Tabs } from '../../../components/ui/Tabs'
import BillForm from './BillForm'

export default function BillsPage() {
  const location = useLocation()
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<BillFilter>('all')
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Bill | null>(null)
  const [openAttachmentsFor, setOpenAttachmentsFor] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Record<string, { items: { name: string; path: string; created_at?: string }[]; loading: boolean; uploading: boolean; error: string | null }>>({})

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
      [billId]: { items: prev[billId]?.items || [], loading: true, uploading: false, error: null },
    }))
    const { items, error } = await listAttachments(billId)
    setAttachments((prev) => ({
      ...prev,
      [billId]: { items, loading: false, uploading: false, error: error ? (error instanceof Error ? error.message : String(error)) : null },
    }))
  }

  async function handleUploadFiles(billId: string, files: FileList | null) {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    setAttachments((prev) => ({
      ...prev,
      [billId]: { items: prev[billId]?.items || [], loading: false, uploading: true, error: null },
    }))
    const { error } = await uploadAttachments(billId, arr)
    if (error) {
      setAttachments((prev) => ({
        ...prev,
        [billId]: { items: prev[billId]?.items || [], loading: false, uploading: false, error: error instanceof Error ? error.message : 'Upload failed' },
      }))
    } else {
      await loadAttachments(billId)
    }
  }

  async function handleDeleteAttachment(billId: string, path: string) {
    if (!confirm('Delete this attachment?')) return
    const { error } = await deleteAttachment(path)
    if (error) {
      setAttachments((prev) => ({
        ...prev,
        [billId]: { items: prev[billId]?.items || [], loading: false, uploading: false, error: error instanceof Error ? error.message : 'Delete failed' },
      }))
    } else {
      await loadAttachments(billId)
    }
  }

  async function handleOpenAttachment(path: string) {
    const { url } = await getDownloadUrl(path)
    if (url) window.open(url, '_blank')
  }

  function copyToClipboard(text: string) {
    if (!text) return
    navigator.clipboard.writeText(text)
  }

  function formatCopyAll(b: Bill): string {
    const lines = [
      `Supplier: ${b.supplier}`,
      `Amount: ${b.amount} ${b.currency}`,
      b.creditor_name ? `Creditor: ${b.creditor_name}` : '',
      b.iban ? `IBAN: ${b.iban}` : '',
      b.reference ? `Reference: ${b.reference}` : '',
      b.purpose ? `Purpose: ${b.purpose}` : '',
      `Due: ${b.due_date}`,
    ].filter(Boolean)
    return lines.join('\n')
  }

  useEffect(() => {
    reload()
  }, [])

  // Read query params for initial UI state (no business logic changes)
  useEffect(() => {
    const sp = new URLSearchParams(location.search)
    const f = sp.get('filter') as BillFilter | null
    if (f && ['all', 'unpaid', 'paid', 'overdue'].includes(f)) {
      setFilter(f)
    }
    const add = sp.get('add')
    if (add === '1') {
      setFormOpen(true)
      setEditing(null)
    }
  }, [location.search])

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
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold">Bills</h2>
        <div className="hidden sm:flex items-center gap-2 text-sm text-neutral-400">
          <Link to="/app" className="hover:text-neutral-200">Bills</Link>
          <span>·</span>
          <Link to="/app/warranties" className="hover:text-neutral-200">Warranties</Link>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Card className="p-3">
          <div className="text-xs text-neutral-400">Unpaid</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-semibold">{analytics.unpaidCount}</span>
            <span className="text-sm text-neutral-300">/ {analytics.unpaidTotal.toFixed(2)}</span>
            <Badge variant={analytics.unpaidCount > 0 ? 'warning' : 'success'}>{analytics.unpaidCount > 0 ? 'Pending' : 'Clear'}</Badge>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-neutral-400">Overdue</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-lg font-semibold">{analytics.overdueCount}</span>
            <span className="text-sm text-neutral-300">/ {analytics.overdueTotal.toFixed(2)}</span>
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-neutral-400">Next due</div>
          <div className="mt-1 text-sm text-neutral-300">
            {analytics.nextDue ? (
              <span>
                {analytics.nextDue.supplier} on {analytics.nextDue.due_date} ({analytics.nextDue.amount} {analytics.nextDue.currency})
              </span>
            ) : (
              <span>—</span>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        <Tabs
          items={[
            { key: 'all', label: 'ALL' },
            { key: 'unpaid', label: 'UNPAID' },
            { key: 'paid', label: 'PAID' },
            { key: 'overdue', label: 'OVERDUE' },
          ]}
          value={filter}
          onChange={(key: string) => setFilter(key as BillFilter)}
        />
        <Input
          type="text"
          placeholder="Search supplier"
          value={query}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          className="flex-1 min-w-40"
        />
        <Button variant="primary" onClick={() => { setFormOpen(true); setEditing(null) }}>Add bill</Button>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="mt-3 text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <Card className="mt-3 p-6 text-center">
          <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-400">🧾</div>
          <p className="text-sm text-neutral-300">No bills found. Add your first bill to start tracking.</p>
          <div className="mt-3">
            <Button variant="primary" onClick={() => { setFormOpen(true); setEditing(null) }}>Add bill</Button>
          </div>
        </Card>
      ) : (
        <ul className="mt-3 grid gap-2">
          {filtered.map((b) => {
            const overdue = isOverdue(b)
            return (
              <li key={b.id} className="card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{b.supplier}</div>
                    <div className="text-xs text-neutral-400">{b.amount} {b.currency} • due {b.due_date}</div>
                    <div className="mt-1">
                      {overdue ? <Badge variant="danger">overdue</Badge> : b.status === 'paid' ? <Badge variant="success">paid</Badge> : <Badge>unpaid</Badge>}
                    </div>
                    <div className="text-[11px] text-neutral-500">Created at {new Date(b.created_at).toLocaleString()}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {b.status === 'paid' ? (
                      <Button onClick={() => handleMark(b.id, 'unpaid')}>Mark unpaid</Button>
                    ) : (
                      <Button onClick={() => handleMark(b.id, 'paid')}>Mark paid</Button>
                    )}
                    <Button onClick={() => { setEditing(b); setFormOpen(true) }}>Edit</Button>
                    <Button variant="danger" onClick={() => handleDelete(b.id)}>Delete</Button>
                    <Button onClick={async () => {
                      const next = openAttachmentsFor === b.id ? null : b.id
                      setOpenAttachmentsFor(next)
                      if (next) await loadAttachments(next)
                    }}>
                      {openAttachmentsFor === b.id ? 'Hide files' : 'Attachments'}
                    </Button>
                    <Button onClick={() => copyToClipboard(b.iban || '')}>Copy IBAN</Button>
                    <Button onClick={() => copyToClipboard(b.reference || '')}>Copy Reference</Button>
                    <Button onClick={() => copyToClipboard(String(b.amount))}>Copy Amount</Button>
                    <Button onClick={() => copyToClipboard(b.purpose || '')}>Copy Purpose</Button>
                    <Button variant="primary" onClick={() => copyToClipboard(formatCopyAll(b))}>Copy All</Button>
                  </div>
                </div>
                {(b.creditor_name || b.iban || b.reference || b.purpose) && (
                  <div className="mt-2 text-xs text-neutral-300">
                    <div className="flex flex-wrap gap-3">
                      {b.creditor_name && <span>Creditor: {b.creditor_name}</span>}
                      {b.iban && <span>IBAN: {b.iban}</span>}
                      {b.reference && <span>Ref: {b.reference}</span>}
                      {b.purpose && <span>Purpose: {b.purpose}</span>}
                    </div>
                  </div>
                )}
                {openAttachmentsFor === b.id && (
                  <div className="mt-3 border-t border-dashed border-neutral-800 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e: ChangeEvent<HTMLInputElement>) => handleUploadFiles(b.id, e.target.files)} />
                      <span className="text-xs text-neutral-400">Upload PDF or images</span>
                      {attachments[b.id]?.uploading && <span className="text-xs">Uploading…</span>}
                    </div>
                    <div className="mt-2">
                      {attachments[b.id]?.loading ? (
                        <div className="text-xs">Loading files…</div>
                      ) : attachments[b.id]?.error ? (
                        <div className="text-xs text-red-400">{attachments[b.id]?.error}</div>
                      ) : (attachments[b.id]?.items || []).length === 0 ? (
                        <div className="text-xs text-neutral-400">No attachments yet.</div>
                      ) : (
                        <ul className="grid gap-2">
                          {(attachments[b.id]?.items || []).map((f) => (
                            <li key={f.path} className="flex items-center justify-between gap-2">
                              <span className="text-xs">{f.name} {f.created_at ? `• uploaded ${new Date(f.created_at).toLocaleString()}` : ''}</span>
                              <div className="flex gap-2">
                                <Button onClick={() => handleOpenAttachment(f.path)}>Open</Button>
                                <Button variant="danger" onClick={() => handleDeleteAttachment(b.id, f.path)}>Delete</Button>
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-3">
          <div className="card w-full max-w-md">
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
