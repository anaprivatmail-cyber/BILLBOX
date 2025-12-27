import { useEffect, useState } from 'react'
import './App.css'
import Login from './pages/Login'
import ProtectedHome from './pages/ProtectedHome'
import { getSession } from './lib/auth'

function App() {
  const [loading, setLoading] = useState(true)
  const [hasSession, setHasSession] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const { data } = await getSession()
      if (!mounted) return
      const active = Boolean(data?.session)
      setHasSession(active)
      setLoading(false)
      const path = window.location.pathname
      if (!active && path !== '/login') {
        window.location.replace('/login')
      }
      if (active && path === '/login') {
        window.location.replace('/')
      }
    })()
    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return <div style={{ padding: 16 }}>Loading…</div>
  }

  const path = window.location.pathname
  if (path === '/login') {
    return <Login />
  }

  return hasSession ? <ProtectedHome /> : null
}

export default App
