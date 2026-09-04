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

- **Phase 1 (implemented):** Premium UI, ZIP upload, local package inspection,
  manifest analysis, permission overview, file structure, configuration checks,
  health score.
- **Phase 2 (existing project):** Advanced manifest analysis, permission
  intelligence, reference resolution, and detailed findings are preserved.
- **Phase 3 (current):** Real browser extension execution inside an isolated
  Chromium container with runtime events, console/network capture, and cleanup.
- **Later phases (planned):** User accounts, saved reports, team
  collaboration, cloud test history, and AI-assisted analysis.

## Phase 3: Isolated Browser Sandbox & Runtime Testing

Phase 3 adds real browser execution inside a fresh, disposable container.

```text
STATIC ANALYSIS → ISOLATED CHROMIUM → REAL EXTENSION EXECUTION → RUNTIME EVENTS → CLEANUP
```

The host application never executes extension code directly. Each test gets a
new non-privileged Docker container with:

- Non-root `node` user
- Dropped Linux capabilities (`--cap-drop ALL`)
- Read-only root filesystem with writable tmpfs
- `no-new-privileges`, `--init`, and a process-count limit
- Hard memory, CPU, runtime, file-count, and event limits
- No Docker socket, no host mounts, no host PID namespace, and no privileged mode
- Restricted network access with a configurable `none` mode for maximum isolation
- Short-lived control port published only to `127.0.0.1`

The uploaded package is copied into the sandbox, then Chromium is started with
`--load-extension` pointing at that package. The browser runs under `xvfb`
because extension rendering requires a non-headless window.

### Runtime workflow

1. Static analysis (Phase 1/2) completes.
2. The frontend uploads the package to `POST /api/sandbox/create`.
3. The API extracts the package into a private temporary directory.
4. `SandboxManager` creates a disposable container and starts the runner.
5. The runner starts Chromium and loads the unpacked extension.
6. The runner opens the default ExtensionLab test page or a validated public URL.
7. Runtime console, network, page, extension, and error events stream back.
8. The tester UI shows a live browser screenshot and runtime panels.
9. Stopping the sandbox terminates the browser, destroys the container, and
   deletes temporary extension and log data.

### Sandbox API

```text
POST  /api/sandbox/create                     create a session (multipart: file, testUrl)
GET   /api/sandbox/:id/status               sandbox state
POST  /api/sandbox/:id/start                start container + browser
POST  /api/sandbox/:id/stop                 stop + destroy
POST  /api/sandbox/:id/reload               reload the test page
POST  /api/sandbox/:id/extension/restart    restart extension session
POST  /api/sandbox/:id/console/clear        clear runtime console
POST  /api/sandbox/:id/open-url             open a validated public URL
GET   /api/sandbox/:id/events               runtime events
GET   /api/sandbox/:id/events/stream        SSE real-time event stream
GET   /api/sandbox/:id/network              network entries
GET   /api/sandbox/:id/screenshot           current live browser frame
```

Every request requires the per-session token from `POST /api/sandbox/create`.
Container IDs and temporary paths are never exposed to clients.

### Runtime tester UI

`/dashboard/test` provides:

- Browser viewport with live sandbox screenshots
- Console, Network, Extension, and Events tabs
- Reload, Restart Extension, Clear Console, and Stop Sandbox controls
- Real backend state only; no simulated runtime results

### Runtime security policy

- Public HTTPS URLs only by default (`http:` is opt-in).
- Loopback, link-local, private RFC1918, IPv6 private, and metadata ranges are blocked.
- DNS resolution is checked server-side before opening a URL.
- Sensitive query parameters, cookies, and authorization headers are redacted.
- Runtime events, logs, network data, extension source, and containers are temporary.
- On failure the API returns a sanitized `referenceId`; internal paths and stack
  traces are never returned.

### Phase 3 configuration (`.env.example`)

```ini
SANDBOX_IMAGE=extensionlab-sandbox:local
SANDBOX_MAX_RUNTIME=120
SANDBOX_MEMORY_LIMIT=768m
SANDBOX_CPU_LIMIT=0.5
SANDBOX_MAX_CONCURRENT=2
SANDBOX_MAX_PER_WINDOW=4
SANDBOX_RATE_LIMIT_WINDOW_MS=60000
SANDBOX_NETWORK_MODE=restricted
SANDBOX_MAX_EVENTS=500
SANDBOX_MAX_EVENT_SIZE=8192
SANDBOX_MAX_LOG_LENGTH=2000
SANDBOX_MAX_NETWORK_EVENTS=200
SANDBOX_ALLOW_HTTP=false
```

### Sandbox image

```bash
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .
```

The container image is intentionally minimal: Node, Chromium, Xvfb, and font
packages. The runner source lives in `sandbox/runner/` and has its own
`package.json` and strict TypeScript build.

### Local development

Install Docker and Docker Compose, then:

```bash
cp .env.example .env.local
npm install
docker build -f sandbox/Dockerfile -t extensionlab-sandbox:local .
npm run dev
```

Launching a sandbox requires a Docker-capable host. GitHub Pages alone cannot
execute sandbox tests.

### Phase 3 automated tests

- `tests/runtime/urls.test.ts` — safe URL policy and DNS/network blocking rules
- `tests/runtime/redact.test.ts` — sensitive data redaction
- `tests/runtime/events.test.ts` — event and log limits
- `tests/runtime/sandbox-manager.test.ts` — state machine, capacity limits,
  rate limits, cleanup, and timeout behavior with a test driver

Docker integration tests are intentionally separated because they require a
container runtime. They should run in an environment with Docker installed and
the `extensionlab-sandbox:local` image built.

### Phase 3 test matrix

```text
Upload → Static Analysis → Sandbox Creation → Browser Start → Extension Load
→ Test Page → Runtime Events → Stop → Cleanup
```

Each stage is independently validated by the manager/runner architecture and
the unit tests above.

## License

Not yet specified. The repository is currently configured for private or
internal use.
