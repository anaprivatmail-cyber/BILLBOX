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
    <div style={{ padding: 12, maxWidth: 640, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Warranties</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/app" style={{ textDecoration: 'none' }}>Bills</Link>
          <span style={{ color: '#999' }}>|</span>
          <Link to="/app/warranties" style={{ textDecoration: 'none' }}>Warranties</Link>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'active', 'expiring', 'expired'] as Array<WarrantyStatus | 'all'>).map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ fontWeight: filter === f ? 'bold' as const : 'normal' }}>{String(f).toUpperCase()}</button>
          ))}
        </div>
        <input type="text" placeholder="Search item" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        <button onClick={() => { setFormOpen(true); setEditing(null) }}>Add</button>
      </div>

      {error && <p style={{ color: 'red', marginTop: 8 }}>{error}</p>}
      {loading ? (
        <p style={{ marginTop: 12 }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ marginTop: 12 }}>No warranties found.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {filtered.map((w) => {
            const status = getWarrantyStatus(w)
            const statusColor = status === 'expired' ? 'red' : status === 'expiring' ? '#d9822b' : 'green'
            return (
              <li key={w.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{w.item_name}</div>
                    <div style={{ fontSize: 12, color: '#555' }}>{w.supplier || '—'} • purchased {w.purchase_date || '—'} • expires {w.expires_at || '—'}</div>
                    <div style={{ fontSize: 12, color: statusColor }}>{status}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setEditing(w); setFormOpen(true) }}>Edit</button>
                    <button onClick={() => handleDelete(w.id)}>Delete</button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {formOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', width: '100%', maxWidth: 480, borderRadius: 8 }}>
            <WarrantyForm initial={editing} onCancel={() => { setFormOpen(false); setEditing(null) }} onSave={handleSave} />
          </div>
        </div>
      )}
    </div>
  )
}
