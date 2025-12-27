import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { getSession } from '../lib/auth'

export default function ProtectedRoute() {
  const [loading, setLoading] = useState(true)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const { data } = await getSession()
      if (!mounted) return
      setOk(Boolean(data?.session))
      setLoading(false)
    })()
    return () => {
      mounted = false
    }
  }, [])

  if (loading) return <div className="px-4 py-8 text-sm text-neutral-300">Loading…</div>
  return ok ? (
    <AppShell>
      <Outlet />
    </AppShell>
  ) : (
    <Navigate to="/login" replace />
  )
}
