import { useEffect, useState } from 'react'
import { Navigate, Outlet, useNavigate } from 'react-router-dom'
import AppShell from '../components/AppShell'
import { getSession, signOut } from '../lib/auth'

export default function ProtectedRoute() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [ok, setOk] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const [showDiag, setShowDiag] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let mounted = true
    console.log('ProtectedRoute: session fetch start')
    const timeoutId = setTimeout(() => {
      if (mounted) setTimedOut(true)
    }, 5000)
    ;(async () => {
      setLoading(true)
      setLastError(null)
      try {
        const { data, error } = await getSession()
        if (!mounted) return
        if (error) {
          setLastError(error.message)
          console.error('ProtectedRoute: getSession error', error)
        }
        setOk(Boolean(data?.session))
      } catch (err: unknown) {
        if (!mounted) return
        const msg = err instanceof Error && err.message ? err.message : 'Unknown error'
        setLastError(msg)
        console.error('ProtectedRoute: getSession exception', err)
      } finally {
        if (mounted) setLoading(false)
        clearTimeout(timeoutId)
        console.log('ProtectedRoute: session fetch end')
      }
    })()
    return () => {
      mounted = false
      clearTimeout(timeoutId)
    }
  }, [retryCount])

  function handleRetry() {
    setTimedOut(false)
    setRetryCount((c) => c + 1)
  }

  async function handleGoLogin() {
    try {
      await signOut()
    } catch (e) {
      console.warn('ProtectedRoute: signOut failed', e)
    }
    navigate('/login', { replace: true })
  }

  if (loading && !timedOut) {
    return <div className="px-4 py-8 text-sm text-neutral-600">Loading…</div>
  }

  if (loading && timedOut) {
    return (
      <div className="mx-auto max-w-md px-4 py-8">
        <div className="card p-5">
          <h3 className="text-lg font-semibold">We couldn't load your session.</h3>
          <p className="mt-1 text-sm text-neutral-600">Please try again, or go back to login.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={handleRetry}>Retry</button>
            <button className="btn btn-secondary" onClick={handleGoLogin}>Go to Login</button>
            <button className="btn" onClick={() => setShowDiag((v) => !v)}>Diagnostics</button>
          </div>
          {showDiag && (
            <div className="mt-3 text-xs text-neutral-500">
              <div>Last error: {lastError || 'none'}</div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return ok ? (
    <AppShell>
      <Outlet />
    </AppShell>
  ) : (
    <Navigate to="/login" replace />
  )
}
