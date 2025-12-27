import { useEffect, useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
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

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>
  return ok ? <Outlet /> : <Navigate to="/login" replace />
}
