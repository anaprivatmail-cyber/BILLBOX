import { useEffect, useMemo, useState } from 'react'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import { listBills, isOverdue } from '../features/bills/api'
import type { Bill } from '../features/bills/types'

function fmt(n: number) { return n.toFixed(2) }

export default function DashboardPage() {
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
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-neutral-400">Overview of your bills and upcoming dues</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading ? (
        <p className="text-sm">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4 sm:col-span-2">
            <div className="text-xs text-neutral-400">Total unpaid</div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-3xl sm:text-4xl font-bold tracking-tight">{fmt(stats.unpaidTotal)}</span>
              <span className="text-sm text-neutral-300">{stats.currency || ''}</span>
              <Badge variant={stats.unpaidTotal > 0 ? 'warning' : 'success'}>{stats.unpaidCount} items</Badge>
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-neutral-400">Overdue</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold">{stats.overdueCount}</span>
              <span className="text-sm text-neutral-300">/ {fmt(stats.overdueTotal)}</span>
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-xs text-neutral-400">Next due</div>
            <div className="mt-1 text-sm text-neutral-300">
              {stats.nextDue ? (
                <span>
                  {stats.nextDue.supplier} on {stats.nextDue.due_date} ({stats.nextDue.amount} {stats.nextDue.currency})
                </span>
              ) : (
                <span>—</span>
              )}
            </div>
          </Card>

          <Card className="p-4 sm:col-span-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-neutral-400">Paid total</div>
                <div className="mt-1 text-lg font-semibold">{fmt(stats.paidTotal)}</div>
              </div>
              <Button variant="primary" onClick={() => { /* Navigate to bills */ location.href = '/app' }}>View bills</Button>
            </div>
            {/* Optional sparkline placeholder without new analytics logic */}
            <div className="mt-3 h-10 rounded-md bg-neutral-900/60 border border-neutral-800 flex items-center justify-center text-xs text-neutral-500">Monthly spend chart unavailable</div>
          </Card>
        </div>
      )}
    </div>
  )
}
