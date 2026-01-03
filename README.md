# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:


## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## BillBox Mobile (Expo) – Production Setup

- Requirements: Node 18+, Expo CLI, EAS account for secrets.
- Mobile app path: `billbox-mobile/`

### Environment Variables (Expo)

Define these in EAS secrets or `.env` (prefixed `EXPO_PUBLIC_`):

- `EXPO_PUBLIC_SUPABASE_URL`: Your Supabase project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key
- `EXPO_PUBLIC_FUNCTIONS_BASE`: Base URL serving Netlify functions (e.g. `https://your-site.netlify.app`)

Expo reads only `process.env.EXPO_PUBLIC_*` at runtime. Do not rely on Netlify envs for the app.

### Environment Variables (Netlify Functions)

Set these in Netlify → Site settings → Environment variables:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: JSON string of service account with Vision API access
  - Must include `private_key` and `client_email`
- (Optional) Supabase service role key if server-side writes are needed

No OCR keys in frontend code. Expo uploads the file to the Netlify OCR function; the function returns parsed JSON only.

### Stripe Checkout (Subscriptions)

Set up products/prices in Stripe Dashboard first, then configure Netlify env vars:

- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key (needed to update `entitlements`)
- `STRIPE_SECRET_KEY`: Stripe secret key (starts with `sk_`)
- `STRIPE_WEBHOOK_SECRET`: Webhook signing secret from the Stripe CLI/Dashboard
- `STRIPE_BASIC_MONTHLY_PRICE_ID`: Price ID for Basic monthly (€2.20)
- `STRIPE_BASIC_YEARLY_PRICE_ID`: Price ID for Basic yearly (€20.00)
- `STRIPE_PRO_MONTHLY_PRICE_ID`: Price ID for Pro monthly (€4.00)
- `STRIPE_PRO_YEARLY_PRICE_ID`: Price ID for Pro yearly (€38.00)
- (optional) `PUBLIC_SITE_URL`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`

Netlify functions created:

- `/.netlify/functions/create-checkout-session` – POST `{ plan: 'basic'|'pro', interval: 'monthly'|'yearly', userId: '<supabase_user_id>' }` → returns `{ url }` to redirect
- `/.netlify/functions/stripe-webhook` – Stripe webhook receiver; activates the `entitlements` record

Example test:

```
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"plan":"basic","interval":"monthly","userId":"YOUR_SUPABASE_USER_ID"}' \
  https://YOUR_SITE.netlify.app/.netlify/functions/create-checkout-session
```

On successful checkout, the webhook sets:

- `plan` to `basic` or `pro`
- `subscription_source` to `stripe`
- `exports_enabled` to `true`
- `ocr_quota_monthly` to a plan-specific quota (adjust in `netlify/functions/stripe-webhook.js`)

### Supabase Policies (entitlements)

RLS base select policy is in `supabase/policies.sql`. If you want clients (non-service-role) to insert/update their own entitlements (e.g., IAP flows), run `supabase/entitlements_policies.sql` in the Supabase SQL editor. If only server-side (Netlify webhook/service role) updates entitlements, you can skip it.

### Features Implemented

- Bills: QR scan (raw text shown), EPC/UPN parsing, OCR from photo, manual entry, review + explicit save
- Warranties: OCR/manual entry with attachments
- Attachments: Image/PDF upload to Supabase Storage, list/open/delete with confirmation
- Offline mode: If Supabase envs missing, data saves locally and appears in lists
- Analytics Dashboard: Total unpaid, total overdue, next due
- Reports: Date range filter, monthly spend bars, top suppliers, export CSV/PDF

### Run

```
cd billbox-mobile
npm install
npm run start
```

Ensure the Expo env variables are set before starting.
You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
