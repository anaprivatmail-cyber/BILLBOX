import { useEffect, useState } from 'react'
import { updatePassword } from '../lib/auth'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'

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
    <div className="min-h-[70vh] flex items-center justify-center px-3 py-6">
      <Card className="w-full max-w-md p-5">
        <h2 className="text-xl font-semibold tracking-tight">Reset Password</h2>
        {message && <p className="mt-2 text-sm text-green-400">{message}</p>}
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          <div>
            <label className="label">New password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <div className="helper mt-1">Choose a strong password you haven’t used before.</div>
          </div>
          <div>
            <label className="label">Confirm password</label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <Button type="submit" variant="primary" disabled={loading} className="w-full mt-2">
            {loading ? 'Please wait…' : 'Update password'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
