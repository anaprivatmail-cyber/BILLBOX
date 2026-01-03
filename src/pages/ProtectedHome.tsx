import { signOut } from '../lib/auth'
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
      <button onClick={handleSignOut}>Sign out</button>
    </div>
  )
}
