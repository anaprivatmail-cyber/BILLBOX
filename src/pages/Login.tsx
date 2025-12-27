import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signUp, sendPasswordResetEmail, getAppUrl, resendConfirmation } from '../lib/auth'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [forgot, setForgot] = useState(false)
  const navigate = useNavigate()

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
        if (isSignUp) {
          setInfo('Account created. Check your email to confirm your address before signing in.')
        } else {
          navigate('/app', { replace: true })
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  async function handleForgot() {
    setError(null)
    setInfo(null)
    const { error } = await sendPasswordResetEmail(email, `${getAppUrl()}/reset`)
    if (error) setError(error.message)
    else setInfo('If an account exists, a reset link was sent.')
  }

  async function handleResend() {
    setError(null)
    const { error } = await resendConfirmation(email)
    if (error) setError('Unable to resend confirmation email. Please try later.')
    else setInfo('Confirmation email resent. Check your inbox.')
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
        {info && (
          <p style={{ color: 'green', marginTop: 8 }}>{info}</p>
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
      {!isSignUp && (
        <div style={{ marginTop: 12 }}>
          <button type="button" onClick={() => setForgot(true)}>Forgot password?</button>
          {forgot && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={handleForgot}>Send reset email</button>
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={handleResend}>Resend confirmation email</button>
      </div>
    </div>
  )
}
