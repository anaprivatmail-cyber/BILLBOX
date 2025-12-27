import { useEffect, useState } from 'react'
import { updatePassword } from '../lib/auth'

export default function Reset() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState<string | null>(
    'Open this page from the password reset link sent to your email.'
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // If the user arrived via Supabase recovery link, they will have a session
    // and updatePassword will succeed.
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (!password || password !== confirm) {
      setError('Passwords must match')
      return
    }
    setLoading(true)
    const { error } = await updatePassword(password)
    if (error) {
      setError(error.message)
    } else {
      setMessage('Password updated. You can now log in.')
    }
    setLoading(false)
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>Reset Password</h2>
      {message && <p style={{ color: 'green' }}>{message}</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            New password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <button type="submit" disabled={loading} style={{ marginTop: 12 }}>
          {loading ? 'Please wait…' : 'Update password'}
        </button>
      </form>
    </div>
  )
}
