# ExtensionLab

> Test your browser extensions.

ExtensionLab is a premium browser-extension inspection and testing platform.
Phase 1 provides a polished web experience for uploading a browser extension
ZIP package and inspecting it locally in the browser.

**Phase 1 does not execute extensions.** It performs:

```text
UPLOAD → EXTRACT → INSPECT → ANALYZE → REPORT
```

Uploaded JavaScript, HTML and other files are treated as untrusted data. They
are never executed, installed, dynamically imported, or injected into the UI.

## Phase 1 scope

- Premium, minimal, responsive user interface
- Light and dark themes with a user-selectable accent colour
- ZIP upload with drag-and-drop and file picker support
- Client-side file validation and size limits
- Local package inspection using `JSZip`
- Manifest detection, including nested top-level folder packages
- Manifest version and standard-field analysis
- Permission and host-permission overview
- File structure browsing
- Basic configuration checks and missing referenced-file detection
- Transparent health score based on implemented checks
- Accessible, keyboard-friendly controls

Phase 1 intentionally does **not** include browser sandboxing, real extension
execution, network monitoring, live console capture, automated browser tests,
user accounts, payments, AI analysis, or cloud test history.

## Requirements

- Node.js 20 or newer (Node 22 is tested)
- npm 10 or newer

## Installation

```bash
npm install
```

## Development

```bash
npm run dev
```

Open the printed local URL. The preview environment binds to all interfaces
so the app can be reached through the hosted preview.

## Build

```bash
npm run build
```

The build fails on TypeScript errors, lint errors, test failures, or
production-build errors.

## Start production

```bash
npm run start
```

## Lint

```bash
npm run lint
```

## Typecheck

```bash
npm run typecheck
```

## Test

```bash
npm run test
```

The test suite covers:

- Valid manifest V3
- Valid manifest V2 with informational compatibility warning
- Missing manifest
- Invalid manifest JSON
- Missing referenced service worker
- Permission detection
- Host-permission extraction and broad-access review
- Nested ZIP manifest detection
- Oversized-file rejection
- Unsupported-file rejection
- Corrupted ZIP graceful error

## Repository architecture

```text
app/
  page.tsx                 Landing page
  layout.tsx               Root layout and theme bootstrap
  globals.css              Design tokens
  dashboard/page.tsx       Extension analysis dashboard
components/
  layout/                  Navbar, Footer, Logo
  landing/                 Hero, HowItWorks, Features, UploadSection, CTA
  extension/               UploadZone, Workbench, dashboard cards
  settings/                Theme and accent selectors
  settings/ThemeProvider   Theme + accent context
  ui/                      Button, Card, Badge, Modal, Progress
lib/
  extension/analyzer.ts    ZIP processing and report orchestration
  extension/manifest.ts    Manifest parsing and feature detection
  extension/permissions.ts Permission analysis
  extension/validation.ts  File acceptance rules
  extension/limits.ts      Configurable safety limits
  theme/theme.ts           Theme and accent persistence
tests/                     Analyzer unit tests
types/extension.ts         Typed analysis result model
```

The analysis logic is independent from React. The UI calls the typed
analyzer and renders the result.

## Architecture flow

```text
UI
 ↓
analyzer.ts
 ↓
manifest parser
 ↓
permission analyzer
 ↓
file analyzer
 ↓
health scorer
 ↓
typed result
 ↓
UI
```

## Security considerations

- The extension ZIP is parsed **without executing any contained code.**
- Uploaded HTML is never rendered directly in the application.
- Uploaded file names are sanitized and displayed as text only.
- A 25 MB uploaded-file limit is enforced before reading.
- A maximum file count is enforced during extraction.
- A total uncompressed-size limit guards against zip bombs.
- A per-file uncompressed-size limit is enforced.
- `manifest.json` is limited to 512 KB before parsing.
- Malformed and corrupted ZIPs fail with a developer-friendly message rather
  than a raw stack trace.
- No secrets or API keys are required by Phase 1.

The limits are configurable constants in
`lib/extension/limits.ts`.

```ts
export const MAX_EXTENSION_SIZE = 25 * 1024 * 1024;
export const MAX_FILE_COUNT = 800;
export const MAX_TOTAL_UNCOMPRESSED_SIZE = 120 * 1024 * 1024;
export const MAX_SINGLE_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_MANIFEST_SIZE = 512 * 1024;
```

## Deployment

The app is a standard static-export-capable Next.js application.

```bash
npm run build
```

Deploy `npm run start` behind any Node-compatible host, or host the output of
`npm run build` on Vercel, Netlify, or a similar platform.

## GitHub Actions

The repository includes `.github/workflows/ci.yml`. On push and pull requests
it will:

1. Install dependencies
2. Run lint
3. Run typecheck
4. Run tests
5. Run the production build

## Roadmap

- **Phase 1 (current):** Premium UI, ZIP upload, local package inspection,
  manifest analysis, permission overview, file structure, configuration checks,
  health score.
- **Phase 2 (planned):** Deeper static analysis, bundled-library detection,
  and richer configuration checks.
- **Phase 3 (planned):** Real browser extension execution in an isolated
  sandbox.
- **Later phases (planned):** User accounts, saved reports, team
  collaboration, cloud test history, and AI-assisted analysis.

## License

Not yet specified. The repository is currently configured for private or
internal use.
