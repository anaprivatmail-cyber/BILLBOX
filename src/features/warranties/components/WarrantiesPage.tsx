import { useEffect, useMemo, useState } from 'react'
import type { Warranty, WarrantyStatus } from '../types'
import { listWarranties, createWarranty, updateWarranty, deleteWarranty, getWarrantyStatus } from '../api'
import WarrantyForm from './WarrantyForm'
import { Link } from 'react-router-dom'

export default function WarrantiesPage() {
  const [items, setItems] = useState<Warranty[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<WarrantyStatus | 'all'>('all')
  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Warranty | null>(null)

  async function reload() {
    setLoading(true)
    const { data, error } = await listWarranties()
    if (error) setError(error.message)
    else setItems(data)
    setLoading(false)
  }

  useEffect(() => { reload() }, [])

  const filtered = useMemo(() => {
    let arr = items.slice()
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      arr = arr.filter((w) => w.item_name.toLowerCase().includes(q) || (w.supplier || '').toLowerCase().includes(q))
    }
    if (filter !== 'all') arr = arr.filter((w) => getWarrantyStatus(w) === filter)
    arr = arr.sort((a, b) => new Date(a.expires_at || '9999-12-31').getTime() - new Date(b.expires_at || '9999-12-31').getTime())
    return arr
  }, [items, filter, query])

  async function handleSave(input: { item_name: string; supplier?: string | null; purchase_date?: string | null; expires_at?: string | null }, id?: string) {
    const payload = { ...input }
    if (id) {
      const { error } = await updateWarranty(id, payload)
      if (error) setError(error.message)
    } else {
      const { error } = await createWarranty(payload)
      if (error) setError(error.message)
    }
    setFormOpen(false)
    setEditing(null)
    reload()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this warranty?')) return
    const { error } = await deleteWarranty(id)
    if (error) setError(error.message)
    reload()
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold">Warranties</h2>
        <div className="hidden sm:flex items-center gap-2 text-sm text-neutral-500">
           <Link to="/app/bills" className="hover:text-neutral-900">Bills</Link>
           <span>·</span>
           <Link to="/app/warranties" className="hover:text-neutral-900">Warranties</Link>
           <span>·</span>
           <Link to="/app/payments" className="hover:text-neutral-900">Payments</Link>
           <span>·</span>
           <Link to="/app/reports" className="hover:text-neutral-900">Reports</Link>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <div className="flex gap-1">
          {(['all', 'active', 'expiring', 'expired'] as Array<WarrantyStatus | 'all'>).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1 text-xs sm:text-sm border ${
              filter === f ? 'bg-brand-50 border-brand-200 text-brand-700' : 'bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100'
            }`}>
              {String(f).toUpperCase()}
            </button>
          ))}
        </div>
        <input type="text" placeholder="Search item" value={query} onChange={(e) => setQuery(e.target.value)} className="input flex-1 min-w-40" />
        <button className="btn btn-primary" onClick={() => { setFormOpen(true); setEditing(null) }}>Add</button>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="mt-3 text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="card mt-3 p-6 text-center">
          <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500">🛡️</div>
          <p className="text-sm text-neutral-600">No warranties found. Add your first warranty to manage coverage.</p>
        </div>
      ) : (
        <ul className="mt-3 grid gap-2">
          {filtered.map((w) => {
            const status = getWarrantyStatus(w)
            const statusColor = status === 'expired' ? 'text-red-600' : status === 'expiring' ? 'text-amber-600' : 'text-green-600'
            return (
              <li key={w.id} className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{w.item_name}</div>
                    <div className="text-xs text-neutral-500">{w.supplier || '—'} • purchased {w.purchase_date || '—'} • expires {w.expires_at || '—'}</div>
                    <div className={`text-xs ${statusColor}`}>{status}</div>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn btn-secondary" onClick={() => { setEditing(w); setFormOpen(true) }}>Edit</button>
                    <button className="btn btn-danger" onClick={() => handleDelete(w.id)}>Delete</button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {formOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-3">
          <div className="card w-full max-w-md">
            <WarrantyForm initial={editing} onCancel={() => { setFormOpen(false); setEditing(null) }} onSave={handleSave} />
          </div>
        </div>
      )}
    </div>
  )
}
