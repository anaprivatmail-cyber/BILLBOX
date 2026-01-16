import { createClient } from '@supabase/supabase-js'

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

async function checkSupabase() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return {
      configured: false,
      dbOk: false,
      billsTableOk: false,
      billsColumnsOk: false,
      error: 'supabase_admin_not_configured',
    }
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

  // Use HEAD selects so we don't return any user data.
  try {
    const probe = await supabase.from('bills').select('id', { head: true, count: 'exact' }).limit(1)
    if (probe.error) {
      return {
        configured: true,
        dbOk: false,
        billsTableOk: false,
        billsColumnsOk: false,
        error: `bills_probe_failed:${probe.error.code || probe.error.message}`,
      }
    }
  } catch (e) {
    return {
      configured: true,
      dbOk: false,
      billsTableOk: false,
      billsColumnsOk: false,
      error: `bills_probe_failed:${(e && e.message) || 'unknown'}`,
    }
  }

  try {
    const columns = ['creditor_name', 'iban', 'reference', 'purpose', 'payment_details', 'invoice_number']
    const colProbe = await supabase
      .from('bills')
      .select(columns.join(','), { head: true })
      .limit(1)

    if (colProbe.error) {
      return {
        configured: true,
        dbOk: true,
        billsTableOk: true,
        billsColumnsOk: false,
        error: `bills_columns_probe_failed:${colProbe.error.code || colProbe.error.message}`,
      }
    }
  } catch (e) {
    return {
      configured: true,
      dbOk: true,
      billsTableOk: true,
      billsColumnsOk: false,
      error: `bills_columns_probe_failed:${(e && e.message) || 'unknown'}`,
    }
  }

  return {
    configured: true,
    dbOk: true,
    billsTableOk: true,
    billsColumnsOk: true,
    error: null,
  }
}

export async function handler(event) {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  // Do not return secret values — only presence booleans.
  const env = process.env;

  const supabaseCheck = await checkSupabase()

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
      supabaseDbOk: Boolean(supabaseCheck.dbOk),
      billsTableOk: Boolean(supabaseCheck.billsTableOk),
      billsColumnsOk: Boolean(supabaseCheck.billsColumnsOk),
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
    checks: {
      supabase: supabaseCheck,
    },
  });
}
