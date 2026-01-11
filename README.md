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

### Important: there are TWO “mobile” folders

- ✅ **Production app**: `billbox-mobile/` (package `com.anaplus.billboxmobile`)
- ❌ **Deprecated stub**: `apps/mobile/` (not used; can look like “nothing changed” if you build it)

If your build has no translations / no packages / AI not working, 90% of the time it is because the build was created from the wrong folder.

**Slovenščina (na kratko):**

- Če buildaš iz napačne mape (npr. `apps/mobile` ali root), dobiš “napačen app” in potem izgleda, kot da ni prevodov/paketov.
- Če build delaš v brskalniku, mora biti koda prej **pushana na GitHub**. Lokalni commiti brez `git push` v buildu ne bodo.

### Why “browser builds” can look like old code

EAS builds started from the web UI (or from GitHub) build **from what is pushed to GitHub**.
If you have local commits that are not pushed, the build will NOT contain them.

Quick check:

- Local: `git status -sb` should show `main...origin/main` (no “ahead”)
- If it says `[ahead N]`, run `tools/push-main.cmd`.

### One safe workflow (recommended)

1) Make changes locally in this repo.
2) Commit.
3) Push to GitHub (`tools/push-main.cmd`).
4) Build **only** from `billbox-mobile/`:
  - APK (fast install): `tools/build-mobile-apk.cmd`
  - AAB (store): `tools/build-mobile-aab.cmd`

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
