import { useState } from 'react'
import { signIn, signUp } from '../lib/auth'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const action = isSignUp ? signUp : signIn
      const { error } = await action(email, password)
      if (error) {
        setError(error.message)
      } else {
        window.location.replace('/')
      }
    } catch (err: any) {
      setError(err?.message || 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2>{isSignUp ? 'Sign Up' : 'Login'}</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
        {error && (
          <p style={{ color: 'red', marginTop: 8 }}>{error}</p>
        )}
        <button type="submit" disabled={loading} style={{ marginTop: 12 }}>
          {loading ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setIsSignUp((v) => !v)}
        style={{ marginTop: 12 }}
      >
        {isSignUp ? 'Have an account? Login' : "Don't have an account? Sign up"}
      </button>
    </div>
  )
}
