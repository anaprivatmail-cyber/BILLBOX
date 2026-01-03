function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function handler(event) {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  // Do not return secret values — only presence booleans.
  const env = process.env;

  return json(200, {
    ok: true,
    service: 'billbox-functions',
    node: process.version,
    has: {
      supabaseUrl: Boolean(env.SUPABASE_URL),
      supabaseServiceRoleKey: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      stripeSecretKey: Boolean(env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
      openaiApiKey: Boolean(env.OPENAI_API_KEY),
      googleCredentialsJson: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    },
  });
}
