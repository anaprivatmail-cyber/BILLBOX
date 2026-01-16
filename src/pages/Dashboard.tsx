import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import { listBills, isOverdue } from '../features/bills/api'
import type { Bill } from '../features/bills/types'

function fmt(n: number) { return Number(n || 0).toFixed(2) }

export default function DashboardPage() {
  const navigate = useNavigate()
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      const { data, error } = await listBills()
      if (error) setError(error.message)
      else setBills(data)
      setLoading(false)
    })()
  }, [])

  const stats = useMemo(() => {
    const unpaid = bills.filter((b) => b.status === 'unpaid')
    const overdue = bills.filter((b) => isOverdue(b))
    const paid = bills.filter((b) => b.status === 'paid')
    const sum = (arr: Bill[]) => arr.reduce((acc, b) => acc + (Number(b.amount) || 0), 0)
    const nextDue = bills
      .filter((b) => b.status !== 'paid')
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null
    const currencies = Array.from(new Set(unpaid.map((b) => b.currency))).filter(Boolean)
    return {
      unpaidTotal: sum(unpaid),
      overdueTotal: sum(overdue),
      paidTotal: sum(paid),
      nextDue,
      currency: currencies.length === 1 ? currencies[0] : undefined,
      unpaidCount: unpaid.length,
      overdueCount: overdue.length,
      paidCount: paid.length,
    }
  }, [bills])

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-neutral-600">Overview of your bills and upcoming dues</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="text-sm">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Hero: Total unpaid */}
          <Card className="p-5 sm:col-span-2 border-brand-200 bg-gradient-to-br from-brand-700 via-brand-600 to-[#0b3cff] text-white overflow-hidden">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-white/80">Total unpaid</div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="text-4xl font-bold tracking-tight">{fmt(stats.unpaidTotal)}</span>
                  <span className="text-sm text-white/85">{stats.currency || 'EUR'}</span>
                  <Badge variant={stats.unpaidTotal > 0 ? 'warning' : 'success'}>{stats.unpaidCount} items</Badge>
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-col sm:flex-row gap-2">
              <Button variant="primary" className="px-4 py-2" onClick={() => navigate('/app/bills?add=1')}>Add bill</Button>
              <Button variant="secondary" className="px-4 py-2 bg-white/95 hover:bg-white text-neutral-900 border-white/40" onClick={() => navigate('/app/payments')}>Go to Payments</Button>
            </div>
          </Card>

          {/* Overdue */}
          <Card className="p-5 border-red-200 bg-white">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-neutral-600">Overdue</div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="text-2xl font-semibold text-red-700">{stats.overdueCount}</span>
                  <span className="text-sm text-neutral-700">/ {fmt(stats.overdueTotal)}</span>
                  <span className="text-xs text-neutral-600">{stats.currency || 'EUR'}</span>
                </div>
              </div>
            </div>
            <div className="mt-3">
              <Button variant="secondary" className="px-4 py-2" onClick={() => navigate('/app/bills?filter=overdue')}>Review overdue</Button>
            </div>
          </Card>

          {/* Next due */}
          <Card className="p-5 border-neutral-200 bg-white">
            <div className="text-xs text-neutral-600">Next due</div>
            <div className="mt-2 text-sm text-neutral-800">
              {stats.nextDue ? (
                <div className="flex items-center gap-2">
                  {/* calendar icon */}
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-brand-50 text-brand-700 border border-brand-100">📅</span>
                  <span className="font-medium">{stats.nextDue.supplier}</span>
                  <span>• {stats.nextDue.due_date}</span>
                  <span>• {fmt(Number(stats.nextDue.amount))}</span>
                  <span className="text-xs text-neutral-600">{stats.nextDue.currency || 'EUR'}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-neutral-600">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-neutral-100 border border-neutral-200">🗓️</span>
                  <span>No upcoming dues — you’re all set.</span>
                </div>
              )}
            </div>
          </Card>

          {/* Paid total */}
          <Card className="p-4 sm:col-span-2">
            <div>
              <div className="text-xs text-neutral-600">Paid total</div>
              <div className="mt-1 text-lg font-semibold text-neutral-900">{fmt(stats.paidTotal)} <span className="text-xs text-neutral-600">{stats.currency || 'EUR'}</span></div>
            </div>
            <div className="mt-3 h-10 rounded-xl bg-neutral-50 border border-neutral-200 flex items-center justify-center text-xs text-neutral-500">Monthly spend chart unavailable</div>
          </Card>
        </div>
      )}
    </div>
  )
}
