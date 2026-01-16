import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { signIn, signUp, sendPasswordResetEmail, getAppUrl, resendConfirmation } from '../lib/auth'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'

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
    <div className="min-h-[70vh] flex items-center justify-center px-3 py-6">
      <Card className="w-full max-w-md p-5">
        <h2 className="text-xl font-semibold tracking-tight">{isSignUp ? 'Sign Up' : 'Login'}</h2>
        <p className="mt-1 text-xs text-neutral-600">Access your BillBox account</p>
        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div>
            <label className="label">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <div className="helper mt-1">Use the email you registered with.</div>
          </div>
          <div>
            <label className="label">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {info && <p className="text-sm text-green-400">{info}</p>}
          <Button type="submit" variant="primary" disabled={loading} className="w-full mt-2">
            {loading ? 'Please wait…' : isSignUp ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        <div className="mt-3 flex items-center justify-between">
          <Button type="button" variant="ghost" className="text-xs px-0" onClick={() => setIsSignUp((v) => !v)}>
            {isSignUp ? 'Have an account? Login' : "No account? Sign up"}
          </Button>
          {!isSignUp && (
            <Button type="button" variant="ghost" className="text-xs px-0" onClick={() => setForgot(true)}>
              Forgot password?
            </Button>
          )}
        </div>
        {forgot && (
          <div className="mt-2">
            <Button type="button" className="w-full" onClick={handleForgot}>Send reset email</Button>
          </div>
        )}
        <div className="mt-2">
          <Button type="button" variant="ghost" className="text-xs px-0" onClick={handleResend}>Resend confirmation email</Button>
        </div>
      </Card>
    </div>
  )
}
