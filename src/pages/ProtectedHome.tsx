import { signOut } from '../lib/auth'

export default function ProtectedHome() {
  async function handleSignOut() {
    const { error } = await signOut()
    if (!error) {
      window.location.replace('/login')
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
