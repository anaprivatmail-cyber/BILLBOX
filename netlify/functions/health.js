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
    deploy: {
      commitRef: process.env.COMMIT_REF || null,
      deployId: process.env.DEPLOY_ID || null,
      context: process.env.CONTEXT || null,
    },
    has: {
      supabaseUrl: Boolean(env.SUPABASE_URL),
      supabaseServiceRoleKey: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      stripeSecretKey: Boolean(env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
      stripeBasicMonthlyPriceId: Boolean(env.STRIPE_BASIC_MONTHLY_PRICE_ID),
      stripeBasicYearlyPriceId: Boolean(env.STRIPE_BASIC_YEARLY_PRICE_ID),
      stripeProMonthlyPriceId: Boolean(env.STRIPE_PRO_MONTHLY_PRICE_ID),
      stripeProYearlyPriceId: Boolean(env.STRIPE_PRO_YEARLY_PRICE_ID),
      stripeSuccessUrl: Boolean(env.STRIPE_SUCCESS_URL || env.PUBLIC_SITE_URL),
      stripeCancelUrl: Boolean(env.STRIPE_CANCEL_URL || env.PUBLIC_SITE_URL),
      openaiApiKey: Boolean(env.OPENAI_API_KEY),
      i18nTranslateToken: Boolean(env.I18N_TRANSLATE_TOKEN),
      googleCredentialsJson: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
      ocrAiEnabled: String(env.ENABLE_OCR_AI || '').toLowerCase() === 'true',
    },
  });
}
