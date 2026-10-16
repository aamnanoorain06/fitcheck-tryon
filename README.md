# FitCheck AI Try-On

A guest-mode virtual try-on app. Guests upload a person photo and a garment photo directly to a private Supabase Storage bucket, start an asynchronous RunPod job, follow its status, and view/download results and past generations.

## Local development

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor. It creates the missing `generations` table and applies the private storage settings to the existing `try on` bucket ID; it does not create another bucket when that ID exists.
3. Copy `.env.example` to `.env` and fill in the Supabase and RunPod values.
4. Install packages with `npm install`.
5. Run `npm run dev`.

Vite serves the UI at `http://fitchek.localhost:5174/` (port 5174 is strict). The Express API runs on port 3001 and Vite proxies `/api` requests to it during local development. For production deployment options and required setup, see [`reports/FitCheck_Deployment_Checklist.md`](reports/FitCheck_Deployment_Checklist.md).

## Environment variables

| Name | Used by | Description |
|---|---|---|
| `SUPABASE_URL` | Server | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Secret service-role key used for database and private-storage operations |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL for signed upload operations |
| `VITE_SUPABASE_ANON_KEY` | Browser | Public anon key; never use the service-role key here |
| `SUPABASE_STORAGE_BUCKET` | Server | Exact private Storage bucket ID; this project currently uses `try on` |
| `RUNPOD_ENDPOINT_ID` | Server only | RunPod endpoint ID |
| `RUNPOD_API_KEY` | Server only | RunPod bearer key |
| `PORT` | Server | Express port (defaults to `3001`) |

`.env` is git-ignored. Do not place RunPod or Supabase service-role secrets in any `VITE_` variable or commit them.

## Generation flow

1. The browser requests a one-time signed upload token from `POST /api/upload-url`.
2. The browser uploads the image bytes directly to the configured private `try on` bucket, avoiding serverless body-size limits. Keep the server setting and the browser bucket constant in `src/App.jsx` in sync.
3. `POST /api/generate` creates a `generations` row, creates short-lived signed input URLs, and starts the RunPod async `/run` job. The RunPod key stays on the server.
4. The browser polls `GET /api/generations/:id`; the API checks RunPod `/status/:jobId` and, on completion, downloads the output into private Storage before returning a signed output URL.
5. `GET /api/history?guest_id=...` returns that guest's rows and temporary signed image URLs.

The UI polls every four seconds for up to five minutes. The active generation ID is kept in session storage so refreshing the playground resumes polling. The generated image is copied into our own bucket so it does not depend on RunPod's expiring output URL.

## Database and storage

The SQL in `supabase/schema.sql` creates the `generations` table and applies private-bucket restrictions to the existing `try on` bucket (JPG, PNG, and WebP images up to 10 MB). Row Level Security is enabled and no anon/authenticated table policies are created. Server-side API calls use the service-role key and explicitly filter history/status operations by the guest UUID.

Guest mode is not account authentication: the UUID in local storage is a bearer identifier. Anyone who obtains that UUID may access that guest's history through the app API. For production, add abuse protection/rate limits and consider signed guest cookies or real authentication. Every RunPod generation costs money; do not add automatic retries or load tests that invoke generation.

## Current limitations

- This workspace is still React + Vite + Express rather than the brief's required Next.js App Router + TypeScript + Tailwind deployment stack. The server endpoints must be hosted alongside the frontend (or routed through a same-origin reverse proxy).
- The project cannot make a real provider request until valid Supabase and RunPod values are configured and `supabase/schema.sql` has been applied.
- The RunPod endpoint must support the specified input field names and accept signed HTTPS image URLs. Check the private endpoint contract if its response shape or optional input fields differ.
- There is no account recovery, persistent cross-device history, abuse/rate limiting, or deletion workflow.
