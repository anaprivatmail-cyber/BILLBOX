import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Bill } from '../features/bills/types'
import { listBills, isOverdue } from '../features/bills/api'

// Chart.js lazy import
let ChartPromise: Promise<typeof import('chart.js/auto')> | null = null
function getChartJS() {
  if (!ChartPromise) ChartPromise = import('chart.js/auto')
  return ChartPromise
}

// jsPDF lazy import
let PdfPromise: Promise<typeof import('jspdf')> | null = null
function getJsPDF() {
  if (!PdfPromise) PdfPromise = import('jspdf')
  return PdfPromise
}

type RangeType = 'month' | 'year' | 'custom'

function parseDate(s: string): Date { return new Date(s) }
function fmt(n: number): string { return Number(n).toFixed(2) }

export default function ReportsPage() {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rangeType, setRangeType] = useState<RangeType>('month')
  const [start, setStart] = useState<string>('')
  const [end, setEnd] = useState<string>('')
  const monthlyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const suppliersCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [chartsReady, setChartsReady] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data, error } = await listBills()
      if (error) setError(error.message)
      else setBills(data)
      setLoading(false)
    })()
  }, [])

  const filtered = useMemo(() => {
    if (rangeType === 'custom' && start && end) {
      const s = new Date(start).getTime()
      const e = new Date(end).getTime()
      return bills.filter((b) => {
        const d = new Date(b.due_date).getTime()
        return d >= s && d <= e
      })
    }
    const now = new Date()
    if (rangeType === 'month') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 0).getTime()
      return bills.filter((b) => {
        const d = new Date(b.due_date).getTime()
        return d >= s && d <= e
      })
    }
    // year
    const s = new Date(now.getFullYear(), 0, 1).getTime()
    const e = new Date(now.getFullYear(), 11, 31).getTime()
    return bills.filter((b) => {
      const d = new Date(b.due_date).getTime()
      return d >= s && d <= e
    })
  }, [bills, rangeType, start, end])

  const stats = useMemo(() => {
    const sum = (arr: Bill[]) => arr.reduce((acc, b) => acc + (Number(b.amount) || 0), 0)
    const paid = filtered.filter((b) => b.status === 'paid')
    const unpaid = filtered.filter((b) => b.status === 'unpaid')
    const overdue = filtered.filter((b) => isOverdue(b))
    const nextDue = filtered.filter((b) => b.status !== 'paid').sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())[0] || null
    return {
      paidTotal: sum(paid),
      paidCount: paid.length,
      unpaidTotal: sum(unpaid),
      unpaidCount: unpaid.length,
      overdueTotal: sum(overdue),
      overdueCount: overdue.length,
      nextDue,
    }
  }, [filtered])

  useEffect(() => {
    ;(async () => {
      const Chart = await getChartJS()
      if (monthlyCanvasRef.current) {
        const ctx = monthlyCanvasRef.current.getContext('2d')
        if (ctx) {
          const byMonth = new Map<string, number>()
          filtered.forEach((b) => {
            const d = parseDate(b.due_date)
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            byMonth.set(key, (byMonth.get(key) || 0) + Number(b.amount))
          })
          const labels = Array.from(byMonth.keys()).sort()
          const data = labels.map((k) => byMonth.get(k) || 0)
          new Chart.default(ctx, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Monthly spend', data, backgroundColor: '#4f46e5' }] },
            options: { responsive: true, maintainAspectRatio: false }
          })
        }
      }
      if (suppliersCanvasRef.current) {
        const ctx = suppliersCanvasRef.current.getContext('2d')
        if (ctx) {
          const bySupplier = new Map<string, number>()
          filtered.forEach((b) => {
            bySupplier.set(b.supplier, (bySupplier.get(b.supplier) || 0) + Number(b.amount))
          })
          const entries = Array.from(bySupplier.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
          const labels = entries.map(([s]) => s)
          const data = entries.map(([, v]) => v)
          new Chart.default(ctx, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Top suppliers', data, backgroundColor: '#16a34a' }] },
            options: { responsive: true, maintainAspectRatio: false }
          })
        }
      }
      setChartsReady(true)
    })()
  }, [filtered])

  function exportCsv() {
    const header = ['id','supplier','amount','currency','due_date','status','creditor_name','iban','reference','purpose']
    const rows = filtered.map((b) => [b.id, b.supplier, String(b.amount), b.currency, b.due_date, b.status, b.creditor_name || '', b.iban || '', b.reference || '', b.purpose || ''])
    const csv = [header.join(','), ...rows.map((r) => r.map((v) => String(v).replace(/"/g, '""')).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bills.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportPdf(summaryOnly = false) {
    const jsPDF = await getJsPDF()
    const doc = new jsPDF.jsPDF()
    let y = 10
    doc.setFontSize(12)
    doc.text('BillBox Report', 10, y); y += 8
    doc.text(`Range: ${rangeType === 'custom' && start && end ? `${start} to ${end}` : rangeType}`, 10, y); y += 8
    doc.text(`Paid: ${fmt(stats.paidTotal)} (${stats.paidCount})`, 10, y); y += 6
    doc.text(`Unpaid: ${fmt(stats.unpaidTotal)} (${stats.unpaidCount})`, 10, y); y += 6
    doc.text(`Overdue: ${fmt(stats.overdueTotal)} (${stats.overdueCount})`, 10, y); y += 8
    if (stats.nextDue) { doc.text(`Next due: ${stats.nextDue.supplier} on ${stats.nextDue.due_date}`, 10, y); y += 8 }

    if (chartsReady) {
      const monthly = monthlyCanvasRef.current?.toDataURL('image/png')
      const suppliers = suppliersCanvasRef.current?.toDataURL('image/png')
      if (monthly) { doc.addImage(monthly, 'PNG', 10, y, 90, 60); y += 65 }
      if (suppliers) { doc.addImage(suppliers, 'PNG', 10, y, 90, 60); y += 65 }
    }

    if (!summaryOnly) {
      doc.addPage()
      let rowY = 10
      doc.text('Bills', 10, rowY); rowY += 8
      filtered.forEach((b) => {
        const line = `${b.due_date} • ${b.supplier} • ${fmt(Number(b.amount))} ${b.currency} • ${b.status}`
        doc.text(line, 10, rowY)
        rowY += 6
      })
    }

    doc.save(summaryOnly ? 'report-summary.pdf' : 'report.pdf')
  }

  return (
    <div style={{ padding: 12, maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Reports</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/app" style={{ textDecoration: 'none' }}>Bills</Link>
          <span style={{ color: '#999' }}>|</span>
          <Link to="/app/warranties" style={{ textDecoration: 'none' }}>Warranties</Link>
          <span style={{ color: '#999' }}>|</span>
          <Link to="/app/payments" style={{ textDecoration: 'none' }}>Payments</Link>
        </div>
      </div>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={rangeType} onChange={(e) => setRangeType(e.target.value as RangeType)}>
              <option value="month">This month</option>
              <option value="year">This year</option>
              <option value="custom">Custom</option>
            </select>
            {rangeType === 'custom' && (
              <>
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
              </>
            )}
            <button onClick={exportCsv}>Export CSV</button>
            <button onClick={() => exportPdf(false)}>Export PDF (summary + charts + table)</button>
            <button onClick={() => exportPdf(true)}>Export PDF (bills list only)</button>
          </div>

          <div style={{ background: '#f6f7f9', padding: 8, borderRadius: 8, marginTop: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <div><strong>Paid:</strong> {stats.paidCount} / {fmt(stats.paidTotal)}</div>
              <div><strong>Unpaid:</strong> {stats.unpaidCount} / {fmt(stats.unpaidTotal)}</div>
              <div><strong>Overdue:</strong> {stats.overdueCount} / {fmt(stats.overdueTotal)}</div>
              {stats.nextDue && (
                <div><strong>Next due:</strong> {stats.nextDue.supplier} on {stats.nextDue.due_date} ({stats.nextDue.amount} {stats.nextDue.currency})</div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, minHeight: 240 }}>
              <h3 style={{ marginTop: 0 }}>Monthly spend</h3>
              <canvas ref={monthlyCanvasRef} style={{ width: '100%', height: 220 }} />
            </div>
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 8, minHeight: 240 }}>
              <h3 style={{ marginTop: 0 }}>Top suppliers</h3>
              <canvas ref={suppliersCanvasRef} style={{ width: '100%', height: 220 }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
