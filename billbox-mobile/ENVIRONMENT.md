# billbox-mobile environment variables

This app uses Expo `EXPO_PUBLIC_*` variables.

## Production builds (EAS)

Set these in **expo.dev → billbox-mobile → Settings → Environment variables**:

- Scope: **Builds only**
- Environment: **production**

Required keys:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_FUNCTIONS_BASE`
- `EXPO_PUBLIC_SITE_URL`

These values must be present **at build time** so Expo can inline them into the JS bundle.

## Local development

Create a local file (recommended):

- `.env.local` (ignored by git)

Do not commit real keys to `.env`.
