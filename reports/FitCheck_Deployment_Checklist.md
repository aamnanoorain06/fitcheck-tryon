# FitCheck Deployment Checklist

**Status:** Preparation only — no deployment has been attempted. No live URL exists.  
**Project stack:** React + Vite frontend; Express 5 API; Supabase database/private Storage; asynchronous RunPod jobs.

## Recommended architecture

### Prototype: one Vercel project with Express Function + Vite static assets

The current prototype targets a single Vercel project. Vercel's official Express integration treats the root `server.mjs` (a recognized Express entrypoint) as a single Function and supports the existing `app.listen()` pattern. The prototype keeps that server and all route logic unchanged. It adds a separate Vite mode that writes built assets under `public/_fitcheck`, and a `vercel.json` exact-root rewrite to that built `index.html`. Existing `/api/*` requests are not rewritten; the intent is for the root Express Function to receive them and use its existing Express router. API responses are marked `private, no-store`.

This prototype is isolated from local behavior:

- `npm run dev` is unchanged and continues to start Vite on 5174 plus Express on 3001.
- `npm run build` is unchanged and still writes the standard Vite bundle to `dist/`.
- `npm run build:vercel` selects a Vercel-only Vite mode, with base `/_fitcheck/`, `publicDir: false`, and output `public/_fitcheck/`; the existing `public/favicon.svg` and `public/icons.svg` are preserved.
- `vercel.json` selects the Express framework and invokes the Vercel build mode. Its root-only rewrite does not match `/api/*`; hash navigation means current in-app views do not need a path-based SPA catch-all.
- `/api/*` requests should be handled by Vercel's detected root Express Function. The local Vite proxy remains unchanged.

**What passed locally:** the prototype config tests, `npm run build:vercel`, asset path/file checks, and browser rendering of `http://fitchek:5174/_fitcheck/index.html`. These validate the static packaging and intended config only. They do **not** prove Vercel framework detection, root rewrite precedence, or actual `/api/*` Function dispatch. Do not call the combined deployment verified until a Vercel preview confirms those paths.

### Fallback: Vercel static frontend + separately hosted Express API

If Vercel's combined framework detection or static/API routing fails in preview, deploy Vite as a static project and run Express on a managed Node host that supports outbound HTTPS, environment variables, and the existing 30-second remote calls. Use an external-origin `/api/:path*` rewrite to preserve the frontend's relative API calls and same-origin browser behavior. This adds a second service/provider but keeps the existing Express process model and avoids a serverless adapter. No backend host is selected in the current prototype.

Compatibility assessment from the source:

- **Runtime/process model:** Routes are regular Express request handlers. There is no in-memory job queue, background worker, long-held five-minute request, WebSocket, or application file persistence. The database/job state and image objects live in Supabase. The browser polls the API through separate requests. The listener pattern is supported by Vercel Express docs, though combined-project routing and cold-start behavior still need a preview test.
- **Startup side effect:** The `app.listen()` callback starts an asynchronous Supabase `listBuckets()` diagnostic. In a Function deployment this can add cold-start network work for each new instance; it is not a persistent background task. Consider moving it to an explicit health/diagnostic operation if preview measurements show material latency or repeated requests.
- **Request bodies/uploads:** Express JSON parsing is capped at 100 KB. API requests carry metadata and prompts, not image bytes. The browser uploads image bytes directly to Supabase via a signed URL. Vercel documents a 4.5 MB Function request/response body limit, so the current direct-upload design avoids sending 10 MB images through a Function. The generated result is fetched server-side (up to 10 MB according to local validation) and stored in Supabase; it is not streamed through the browser response.
- **Timeouts/durations:** `requestRunPod()` and `retrieveRunPodImage()` each have 30-second abort timeouts. A completed-job status request and image retrieval occur sequentially in one API invocation, so a slow path may take about 60 seconds plus Supabase work. The browser's five-minute polling window is across many independent requests, not one invocation. Current Vercel docs list Fluid-compute Node function duration defaults of 300 seconds; Hobby max 300 seconds; Pro/Enterprise max 800 seconds, with 1800 seconds in beta for supported configurations. No Vercel plan is selected. Supabase operations do not have explicit app-level timeouts, so platform termination and 504s remain possible; set/verify an adequate function maximum and test on the chosen plan.
- **Response behavior:** Endpoints return JSON and do not require response streaming. No cookie-based login or credentialed CORS flow exists. Relative `/api/*` calls work unchanged only if Vercel routes those paths to the Express Function; frontend-to-Supabase Storage remains cross-origin and must be verified separately.
- **Function limits:** Vercel documents a 4.5 MB Function request/response payload limit and a standard 250 MB uncompressed Function bundle limit. Current API request JSON is capped at 100 KB and image upload is direct to Supabase; measure the actual Function bundle when a deployment layout is selected.

## Build and run commands

### Existing local workflow (unchanged)

- Install: `npm ci`
- Local development: `npm run dev` (starts both local Express and Vite; do not start another copy while ports 3001/5174 are occupied)
- Existing production build: `npm run build` (Vite output in `dist/`)

### Combined Vercel prototype build

- Build: `npm run build:vercel` (Vite output in `public/_fitcheck/`; generated output is ignored by Git)
- Vercel config: framework `express`, custom build command `npm run build:vercel`, exact `/` rewrite to `/_fitcheck/index.html`, API no-store response header
- Express Function entry: root `server.mjs`; its existing `app.listen()` pattern is documented as supported by Vercel Express
- Static URLs: page at `/` via rewrite; built assets under `/_fitcheck/assets/...`; current public icons/favicon remain at their existing paths
- Health check after preview: `GET /api/health`

These are local prototype settings. The custom build has been tested; Vercel build detection, static routing, and Function dispatch require a Vercel preview before being considered verified.

## Environment variable names

Configure production values in the appropriate Vercel/backend-host settings. This checklist intentionally contains names only, never values.

**Backend-only variables:**

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — secret; backend only
- `SUPABASE_STORAGE_BUCKET` — exact bucket ID; current project expects `try on`
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY` — secret; backend only
- `PORT` — use the platform-provided port when required

**Vite build-time/browser variables:**

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY` — public/publishable browser key only

Do not put the service-role key or RunPod key in any `VITE_` variable. Do not upload or commit `.env`; it is ignored by `.gitignore`. Vite `VITE_` values are embedded in browser assets at build time.

## Supabase production requirements

- Confirm `SUPABASE_URL` and `VITE_SUPABASE_URL` refer to the same production project.
- Apply `supabase/schema.sql` to that project. It creates `public.generations`, enables RLS, and sets private-bucket constraints for the expected existing bucket ID.
- Confirm the private Storage bucket ID exactly matches `SUPABASE_STORAGE_BUCKET` and the browser bucket constant in `src/App.jsx` (currently `try on`, including the space).
- Keep the bucket private, with JPG/PNG/WebP MIME restrictions and the 10 MB object limit.
- Give the backend service-role key access only through backend environment settings; use the publishable/anon key in the browser.
- Verify signed-upload and signed-read URL behavior against the production project. Confirm the deployed frontend origin is accepted by Supabase Storage/API CORS controls where applicable.

## RunPod requirements

- Set `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY` only on the backend host.
- Verify that the endpoint belongs to the account for that API key and accepts the existing `model_img`, `cloth_img`, prompt, and other payload fields.
- Confirm its asynchronous `/run` and `/status/:jobId` behavior and that completed output exposes an image URL/data URI in the supported `output.image` or `output.url` fields.
- Keep signed input URLs valid long enough for the worker to fetch them; verify output retrieval and storage of the returned image.
- The unit suite models a numeric type mismatch message (“Inputs which are supposed to be numbers are in alphabet”) and classifies it correctly. This is synthetic test data, not a confirmed live endpoint error. The worker schema is not in this repository, so the offending field and expected type are unresolved; do not add numeric fields speculatively.
- Mocked tests pass, but the private endpoint contract and a real generation have not been verified. Do not submit a production job without explicit charge authorization.

## API routing, CORS, and auth

- **Combined prototype:** Vercel's Express framework should send non-static requests to the root Express Function; its router already defines the `/api/*` endpoints. `vercel.json` rewrites only exact `/` to the generated static index, so it does not catch API paths. Confirm the actual `/api/*` dispatch in a preview before production.
- **Fallback external API:** If Express framework detection/routing fails, use an external-origin rewrite for `/api/:path*` to the selected backend origin. Preserve the frontend's relative `/api` calls.
- Same-origin Function dispatch or a same-origin external rewrite requires no browser-to-Express CORS. If the frontend calls a separate backend directly, introduce an API base setting and configure CORS for exact Vercel origins.
- Vercel's current external-origin rewrites can honor upstream cache headers by default. History and generation endpoints contain guest-specific data and temporary signed image URLs; configure API responses as `Cache-Control: private, no-store` and/or explicitly disable rewrite caching for `/api/*`, then verify the deployed response headers.
- The prototype sets `Cache-Control: private, no-store` for `/api/:path*` in `vercel.json`; verify the header survives Express Function routing in preview.
- No cookie-based auth is present; do not enable credentialed cookies unless the app's auth design changes.
- Browser-to-Supabase Storage calls remain cross-origin and must be verified from the deployed site.
- The UI switches between Try on and History using URL hash fragments, not path routes. A blanket SPA fallback is not currently needed for those views; if a fallback is added, ensure `/api/*` is routed first and never rewritten to `index.html`.
- Guest mode stores a UUID in `localStorage`; it is a bearer identifier, not authentication. Add abuse controls/rate limiting and consider real authentication or signed guest identity before public launch. The current per-guest generation limit alone is not strong abuse protection.

## Security and verification checklist

- [ ] Link an authorized Vercel project and confirm its plan/runtime settings before preview.
- [ ] Add the backend-only environment variables to Vercel Function runtime settings; add only the two browser-safe Supabase variables to Vercel's build environment.
- [ ] Set the exact private bucket ID and apply the database/storage SQL to the intended production project.
- [ ] Preview-test root rewrite/static assets and each `/api/*` route (including query strings and POST JSON bodies); verify `/api` is never returned as `index.html`.
- [ ] Confirm no `.env` file or secret values are committed/uploaded; scan the final `dist/` bundle for server-only secrets.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, and `npm run build:vercel` before deployment.
- [ ] Deploy a staging frontend/backend first; verify frontend route, `/api/health`, history read, signed upload URL, and safe temporary upload/cleanup.
- [ ] Verify error handling, job polling, and generated-result storage with mocks or a specifically authorized test job.
- [ ] Verify HTTPS, allowed origins, private storage, signed URL expiry, logging redaction, rate controls, and rollback procedure.
- [ ] Record the actual Vercel URL only after deployment and HTTP verification.

### Rollback

The prototype is limited to `vite.config.js`, `package.json`, `.gitignore`, `vercel.json`, and `test/vercel-prototype.test.mjs`; its build output is `public/_fitcheck/`. If preview routing fails, remove the `build:vercel` script and Vercel-only Vite mode, remove only the `/public/_fitcheck/` ignore entry, delete `public/_fitcheck/`, `vercel.json`, and the prototype test, then return to the previously working Vercel-frontend/separate-API approach. Do not revert the pre-existing application fixes in `src/App.jsx` or `server.mjs`.

## Vercel CLI and prerequisites

The Vercel CLI is not installed, no Vercel project is linked, and Vercel authentication/project environment variables are absent. A local `vercel.json` prototype now exists, but it is not linked or deployed. The npm registry is reachable and the global npm prefix is writable, so CLI installation is technically available; it was not installed because the user explicitly deferred it.

When ready, install the CLI with `npm install --global vercel`, authenticate with `vercel login`, then link the intended project with `vercel link`. Configure environment variables through Vercel/backend-host settings or the CLI without pasting secret values into chat. Do not run `vercel deploy` until the API routing/hosting approach and production environment are ready.

## Current deployment decision

**Pause before deployment.** Option 1's local packaging/config prototype is complete. Before production, authorize a Vercel preview (CLI install/auth/link still deferred), confirm the Vercel plan/function duration, and verify the root static rewrite plus Express handling of every `/api/*` route. If that integration fails, use the documented separate-API fallback. No production deployment or live URL is claimed.

## Official documentation checked

Reviewed on 2026-10-16:

- [Express on Vercel](https://vercel.com/docs/frameworks/backend/express) — single Function model, root entrypoint names, `app.listen()` support, `public/**` static asset behavior, and Express limitations (last updated 2026-08-10).
- [Using the Node.js Runtime with Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js) — `/api` function entrypoints, Node APIs, request/response body behavior, and Node runtime support (last updated 2026-08-11).
- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) — 4.5 MB request/response payload limit, bundle/memory limits, and plan duration limits (last updated 2026-08-24).
- [Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration) — `maxDuration` configuration and current Fluid-compute defaults/maxima (last updated 2026-08-24).
- [Rewrites on Vercel](https://vercel.com/docs/routing/rewrites) — same-origin rewrites to external API origins and caching behavior (last updated 2026-08-11).
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite) — Vite build/static output and SPA rewrites (last updated 2026-08-26).
- [Vercel project configuration (`vercel.json`)](https://vercel.com/docs/project-configuration/vercel-json) — build command, output directory, and rewrites configuration (last updated 2026-08-14).
- [Vercel Builds](https://vercel.com/docs/deployments/builds) — build command/output configuration and deployment artifact behavior (last updated 2026-09-03).
