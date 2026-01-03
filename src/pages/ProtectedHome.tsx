import { signOut } from '../lib/auth'
import { startCheckout } from '../lib/stripe'
import { useNavigate } from 'react-router-dom'

export default function ProtectedHome() {
  const navigate = useNavigate()
  async function handleSignOut() {
    const { error } = await signOut()
    if (!error) {
      navigate('/login', { replace: true })
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>Home</h2>
      <p>You are signed in.</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={async () => { const { url } = await startCheckout('basic', 'monthly'); window.location.href = url }}>Basic (Monthly)</button>
        <button onClick={async () => { const { url } = await startCheckout('basic', 'yearly'); window.location.href = url }}>Basic (Yearly)</button>
        <button onClick={async () => { const { url } = await startCheckout('pro', 'monthly'); window.location.href = url }}>Pro (Monthly)</button>
        <button onClick={async () => { const { url } = await startCheckout('pro', 'yearly'); window.location.href = url }}>Pro (Yearly)</button>
      </div>
      <button onClick={handleSignOut}>Sign out</button>
    </div>
  )
}
