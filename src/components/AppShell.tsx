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
      <header className="sticky top-0 z-30 border-b border-neutral-200/70 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70 shadow-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-xl bg-gradient-to-b from-brand-600 to-brand-800 shadow-soft"></div>
                <span className="text-base font-semibold tracking-wide text-neutral-900">BillBox</span>
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
        `rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-brand-50 text-brand-800 border border-brand-200'
            : 'text-neutral-700 hover:text-neutral-900 hover:bg-neutral-100'
        }`
      }
    >
      {label}
    </NavLink>
  )
}

function MobileNav() {
  return (
    <div className="md:hidden border-t border-neutral-200/70 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
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
        `text-center text-[13px] py-3 ${
          isActive
            ? 'text-brand-800 font-semibold border-b-2 border-brand-500'
            : 'text-neutral-600 hover:text-neutral-900'
        }`
      }
    >
      {label}
    </NavLink>
  )
}
