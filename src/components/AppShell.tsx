import type { PropsWithChildren } from 'react'
import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { signOut } from '../lib/auth'

export default function AppShell({ children }: PropsWithChildren) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    setBusy(true)
    await signOut()
    setBusy(false)
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-neutral-800/80 bg-neutral-950/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-md bg-brand-600"></div>
                <span className="text-base font-semibold tracking-wide text-neutral-100">BillBox</span>
              </div>
              <nav className="ml-3 hidden md:flex items-center gap-2">
                <TopLink to="/app/dashboard" label="Dashboard" />
                <TopLink to="/app/bills" label="Bills" />
                <TopLink to="/app/warranties" label="Warranties" />
                <TopLink to="/app/payments" label="Payments" />
                <TopLink to="/app/reports" label="Reports" />
              </nav>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-secondary px-3 py-2 text-sm" onClick={handleLogout} disabled={busy}>
                {busy ? 'Signing out…' : 'Logout'}
              </button>
            </div>
          </div>
        </div>
        <MobileNav />
      </header>
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-5">
        {children}
      </main>
    </div>
  )
}

function TopLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-full px-3 py-1.5 text-sm transition-colors ${
          isActive
            ? 'bg-neutral-800 text-neutral-100 shadow-soft border border-neutral-700'
            : 'text-neutral-300 hover:text-neutral-100'
        }`
      }
    >
      {label}
    </NavLink>
  )
}

function MobileNav() {
  return (
    <div className="md:hidden border-t border-neutral-900 bg-neutral-950">
      <div className="mx-auto max-w-7xl px-3 sm:px-4">
        <div className="grid grid-cols-5">
          <MobileLink to="/app/dashboard" label="Dashboard" />
          <MobileLink to="/app/bills" label="Bills" />
          <MobileLink to="/app/warranties" label="Warr." />
          <MobileLink to="/app/payments" label="Pay" />
          <MobileLink to="/app/reports" label="Reports" />
        </div>
      </div>
    </div>
  )
}

function MobileLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `text-center text-sm py-3 ${
          isActive ? 'text-neutral-100 border-b-2 border-brand-500' : 'text-neutral-400 hover:text-neutral-200'
        }`
      }
    >
      {label}
    </NavLink>
  )
}
