import Stripe from 'stripe'

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2024-11-20', typescript: false })
}

function parseBody(event) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || ''
  try {
    if (/application\/json/i.test(contentType)) return JSON.parse(event.body || '{}')
    return {}
  } catch {
    return {}
  }
}

const PLAN_PRICE_ENV = {
  basic: {
    monthly: 'STRIPE_BASIC_MONTHLY_PRICE_ID',
    yearly: 'STRIPE_BASIC_YEARLY_PRICE_ID',
  },
  pro: {
    monthly: 'STRIPE_PRO_MONTHLY_PRICE_ID',
    yearly: 'STRIPE_PRO_YEARLY_PRICE_ID',
  },
}

export async function handler(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' })
    }

    const stripe = getStripe()
    if (!stripe) {
      return jsonResponse(500, { ok: false, error: 'missing_STRIPE_SECRET_KEY' })
    }

    const body = parseBody(event)
    const plan = String(body.plan || '').toLowerCase()
    const interval = String(body.interval || 'monthly').toLowerCase()
    const userId = String(body.userId || '')

    if (!['basic', 'pro'].includes(plan)) {
      return jsonResponse(400, { ok: false, error: 'invalid_plan', message: 'plan must be basic or pro' })
    }
    if (!userId) {
      return jsonResponse(400, { ok: false, error: 'missing_userId' })
    }

    if (!['monthly', 'yearly'].includes(interval)) {
      return jsonResponse(400, { ok: false, error: 'invalid_interval', message: 'interval must be monthly or yearly' })
    }

    const priceEnv = PLAN_PRICE_ENV[plan]?.[interval]
    const priceId = priceEnv ? process.env[priceEnv] : null
    if (!priceId) {
      return jsonResponse(500, { ok: false, error: 'missing_price_id', detail: `Set ${priceEnv} in environment` })
    }

    const successUrl = body.success_url || process.env.STRIPE_SUCCESS_URL || `${process.env.PUBLIC_SITE_URL || 'https://example.com'}/payments?status=success`
    const cancelUrl = body.cancel_url || process.env.STRIPE_CANCEL_URL || `${process.env.PUBLIC_SITE_URL || 'https://example.com'}/payments?status=cancel`

    // Create a recurring subscription checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, plan, interval },
    })

    return jsonResponse(200, { ok: true, id: session.id, url: session.url })
  } catch (err) {
    const msg = (err && err.message) || 'stripe_error'
    return jsonResponse(500, { ok: false, error: 'stripe_error', detail: msg })
  }
}
