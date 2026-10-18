import express from 'express'
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import {
  buildTryOnInput,
  getRunPodFailureCategory,
  getRunPodFailureMessage,
  interpretRunPodResponse,
  retrieveRunPodImage,
  requestRunPod,
  validateTryOnInput,
} from './runpod-job.mjs'

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) })

const app = express()
const port = Number(process.env.PORT || 3001)
const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'try on'
const defaultPrompt = "Take the person from image 1 and dress them in the item shown in image 2, keeping the person's pose, facial identity, hair, body proportions, lighting, and background unchanged, only replacing or adding the item with realistic color, fabric, and fit for a seamless, photorealistic try-on."
const maxImageBytes = 10 * 1024 * 1024
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

app.use(express.json({ limit: '100kb' }))

function getSupabase() {
  const SUPABASE_URL = process.env.SUPABASE_URL?.trim()
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Supabase server configuration is missing.')
    error.publicMessage = 'Supabase is not configured on the server. Check the server environment settings.'
    throw error
  }
  let parsedUrl
  try {
    parsedUrl = new URL(SUPABASE_URL)
  } catch {
    const error = new Error('Supabase URL is invalid.')
    error.publicMessage = 'The Supabase server URL is invalid. Check SUPABASE_URL in the server environment.'
    throw error
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.host) {
    const error = new Error('Supabase URL is invalid.')
    error.publicMessage = 'The Supabase server URL is invalid. Check SUPABASE_URL in the server environment.'
    throw error
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function getRunPodConfig() {
  const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID?.trim()
  const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY?.trim()
  if (!RUNPOD_ENDPOINT_ID || !RUNPOD_API_KEY) {
    const error = new Error('RunPod configuration is missing.')
    error.publicMessage = 'AI generation is not configured. Check RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY in the server environment.'
    throw error
  }
  if (!/^[A-Za-z0-9_-]{6,}$/.test(RUNPOD_ENDPOINT_ID)) {
    const error = new Error('RunPod endpoint ID has an invalid format.')
    error.publicMessage = 'The RunPod endpoint ID format is invalid. Check RUNPOD_ENDPOINT_ID in the server environment.'
    throw error
  }
  return { endpointId: RUNPOD_ENDPOINT_ID, apiKey: RUNPOD_API_KEY }
}

function requireGuestId(value) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    const error = new Error('A valid guest_id is required.')
    error.statusCode = 400
    error.publicMessage = 'A valid guest_id is required.'
    throw error
  }
  return value
}

function getHttpStatus(error) {
  if (['PGRST205', '42P01'].includes(error?.code)) return 503
  if (error?.code === 'PGRST116') return 404
  if (error?.runpodOperation) return 502
  const candidate = error?.statusCode ?? error?.status
  const status = typeof candidate === 'number' || (typeof candidate === 'string' && /^\d{3}$/.test(candidate))
    ? Number(candidate)
    : 500
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

function getSafeErrorMessage(error, status = getHttpStatus(error), diagnostic) {
  if (typeof error?.publicMessage === 'string') return error.publicMessage
  if (['PGRST205', '42P01'].includes(error?.code)) {
    return 'The FitCheck database schema is not installed or is not available yet. Run supabase/schema.sql in the Supabase SQL Editor, then retry.'
  }
  if (error?.runpodOperation) return getRunPodFailureMessage(error.runpodStatus)
  if (error?.storageOperation === 'upload-url' && diagnostic?.bucketListOk && !diagnostic.bucketFound) {
    return `The configured Supabase project does not contain a Storage bucket with ID "${bucket}". Check the project host and exact bucket ID; this app does not create buckets automatically.`
  }
  if ((status === 401 || status === 403 || diagnostic?.authRejected) && error?.storageOperation) {
    return 'Supabase rejected the server credentials or their Storage permissions. Verify the server key belongs to the configured project and has Storage access.'
  }
  if (error?.storageOperation === 'upload-url' && status === 404) {
    return 'Supabase Storage reports that a resource for this signed-upload request does not exist. Check the exact project, bucket ID, and Storage API response in the server logs.'
  }
  if (error?.storageOperation === 'upload-url' && status === 400) {
    return 'Supabase rejected the signed-upload request. Check its request validation details in the server logs.'
  }
  if (status === 404) return 'The requested resource was not found.'
  if (status === 400) return 'The request is invalid. Check the submitted values and try again.'
  if (status === 413) return 'The request is too large. Images must be 10 MB or smaller.'
  if (status === 429) return 'The request limit has been reached. Please try again later.'
  return 'The server could not complete the request. Check the server configuration and try again.'
}

function getInputFieldTypes(input) {
  return Object.fromEntries(Object.entries(input || {}).map(([name, value]) => [name, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value]))
}

function logRunPodFailure(operation, status, payload, requestId, category, inputFieldTypes) {
  console.error('[runpod] Request failed:', {
    operation,
    requestId: requestId || null,
    statusCode: status,
    errorCategory: category || getRunPodFailureCategory(status, payload),
    inputFieldTypes: inputFieldTypes || undefined,
    outputKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
  })
}

async function diagnoseStorageConfiguration(supabase) {
  const projectHost = new URL(process.env.SUPABASE_URL.trim()).host
  const { data: buckets, error } = await supabase.storage.listBuckets()
  if (error) {
    const status = Number(error.statusCode ?? error.status)
    return {
      projectHost,
      bucketListOk: false,
      authRejected: status === 401 || status === 403,
      bucketListStatus: Number.isInteger(status) ? status : null,
      bucketListCode: redactSecrets(error.code) || null,
      bucketListMessage: redactSecrets(error.message) || null,
    }
  }
  const bucketFound = (buckets || []).some((item) => item.id === bucket)
  return {
    projectHost,
    bucketListOk: true,
    bucketFound,
    bucketIds: (buckets || []).map((item) => item.id),
  }
}

function redactSecrets(value) {
  let safeValue = String(value ?? '')
  for (const secret of [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.RUNPOD_API_KEY]) {
    if (secret) safeValue = safeValue.split(secret).join('[REDACTED]')
  }
  return safeValue
}

function logStorageDiagnostic(event, diagnostic, error) {
  const upstreamStatus = Number(error?.statusCode ?? error?.status)
  console.error(`[storage] ${event}`, {
    projectHost: diagnostic?.projectHost || null,
    configuredBucket: bucket,
    exactBucketIdFound: diagnostic?.bucketFound ?? null,
    bucketIds: diagnostic?.bucketIds || undefined,
    bucketListStatus: diagnostic?.bucketListStatus || undefined,
    bucketListCode: diagnostic?.bucketListCode || undefined,
    bucketListMessage: diagnostic?.bucketListMessage || undefined,
    upstreamStatus: Number.isInteger(upstreamStatus) ? upstreamStatus : null,
    upstreamCode: redactSecrets(error?.code) || null,
    upstreamMessage: redactSecrets(error?.message) || null,
  })
}

function publicGenerationError(error) {
  if (!error) return null
  const publicMessages = [
    'RunPod reports a numeric input type mismatch. The worker schema is not present in this project, so verify its documented numeric fields and types before changing the request payload.',
    'The endpoint completed without an image result. Verify its output schema returns an image URL or image field.',
    'The endpoint returned an invalid image URL. Check the worker output schema.',
    'Runpod returned an image result, but it could not be retrieved. Check the worker output URL and endpoint logs.',
    'Runpod returned an image result, but it was empty or could not be retrieved. Check the worker output URL and endpoint logs.',
    'RunPod rejected the generation input. Check the endpoint worker input schema and accepted image format.',
  ]
  if (publicMessages.includes(error)) return error
  return 'This generation could not be completed. Please try again.'
}

function sendError(response, error, diagnostic) {
  const status = getHttpStatus(error)
  const message = getSafeErrorMessage(error, status, diagnostic)
  console.error('[api] Request failed:', {
    statusCode: status,
    operation: error?.storageOperation || 'unknown',
    stage: error?.stage || 'unclassified',
    requestId: error?.requestId || null,
    errorCode: redactSecrets(error?.code) || null,
    message,
  })
  return response.status(status).json({ error: message })
}

async function signedImageUrl(supabase, path) {
  if (!path) return null
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60)
  if (error) throw error
  return data.signedUrl
}

async function markGenerationFailed(supabase, generation, guestId, message) {
  const { data, error } = await supabase
    .from('generations')
    .update({ status: 'failed', error: message })
    .eq('id', generation.id)
    .eq('guest_id', guestId)
    .select('*')
    .single()
  if (error) throw error
  Object.assign(generation, data)
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, name: 'fitcheck-tryon' })
})

app.post('/api/upload-url', async (request, response) => {
  let supabase
  try {
    const guestId = requireGuestId(request.body?.guest_id)
    const { kind, contentType, size } = request.body ?? {}
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

    if (!['person', 'garment'].includes(kind) || !extensions[contentType]) {
      return response.status(400).json({ error: 'Choose a person or garment image in JPG, PNG, or WebP format.' })
    }
    if (!Number.isInteger(size) || size <= 0 || size > maxImageBytes) {
      return response.status(400).json({ error: 'Images must be smaller than 10 MB.' })
    }

    supabase = getSupabase()
    const path = `inputs/${guestId}/${kind}-${crypto.randomUUID()}.${extensions[contentType]}`
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: false })
    if (error) {
      error.storageOperation = 'upload-url'
      throw error
    }

    response.json({ path, token: data.token })
  } catch (error) {
    let diagnostic
    if (supabase && error?.storageOperation === 'upload-url') {
      try {
        diagnostic = await diagnoseStorageConfiguration(supabase)
      } catch (diagnosticError) {
        const diagnosticStatus = Number(diagnosticError?.statusCode ?? diagnosticError?.status)
        diagnostic = {
          projectHost: new URL(process.env.SUPABASE_URL.trim()).host,
          bucketListOk: false,
          authRejected: diagnosticStatus === 401 || diagnosticStatus === 403,
          bucketListStatus: Number.isInteger(diagnosticStatus) ? diagnosticStatus : null,
          bucketListCode: diagnosticError?.code || null,
          bucketListMessage: diagnosticError?.message || null,
        }
      }
      logStorageDiagnostic('signed-upload URL failed', diagnostic, error)
    }
    sendError(response, error, diagnostic)
  }
})

app.post('/api/generate', async (request, response) => {
  let supabase
  let generationId
  let guestId
  let stage = 'request-validation'
  try {
    const { guest_id: rawGuestId, person_path: personPath, garment_path: garmentPath } = request.body ?? {}
    guestId = requireGuestId(rawGuestId)
    if (typeof personPath !== 'string' || typeof garmentPath !== 'string' ||
        !personPath.startsWith(`inputs/${guestId}/person-`) || !garmentPath.startsWith(`inputs/${guestId}/garment-`)) {
      return response.status(400).json({ error: 'Upload a person photo and garment photo before generating.' })
    }

    supabase = getSupabase()
    stage = 'guest-limit-check'
    const { endpointId, apiKey } = getRunPodConfig()
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count, error: countError } = await supabase
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .eq('guest_id', guestId)
      .gte('created_at', since)
    if (countError) throw countError
    if (count >= 10) {
      return response.status(429).json({ error: 'You have reached the guest limit of 10 try-ons per day. Please come back tomorrow.' })
    }

    stage = 'input-url-signing'
    const { data: signedInputs, error: signError } = await Promise.all([
      supabase.storage.from(bucket).createSignedUrl(personPath, 30 * 60),
      supabase.storage.from(bucket).createSignedUrl(garmentPath, 30 * 60),
    ]).then(([person, garment]) => ({ data: [person.data, garment.data], error: person.error || garment.error }))
    if (signError) throw signError

    if (!signedInputs?.[0]?.signedUrl || !signedInputs?.[1]?.signedUrl) {
      const error = new Error('Supabase did not return signed image URLs.')
      error.stage = stage
      error.publicMessage = 'FitCheck could not prepare the uploaded photos for AI processing. Verify that both image uploads completed, then retry.'
      throw error
    }

    const prompt = typeof request.body.prompt === 'string' && request.body.prompt.trim()
      ? request.body.prompt.trim().slice(0, 2000)
      : defaultPrompt

    stage = 'generation-record-create'
    const { data: generation, error: insertError } = await supabase
      .from('generations')
      .insert({ guest_id: guestId, person_path: personPath, garment_path: garmentPath, prompt, status: 'queued' })
      .select('id')
      .single()
    if (insertError) throw insertError
    generationId = generation.id

    const runInput = buildTryOnInput({
      requestId: `tryon-${generation.id}`,
      personImageUrl: signedInputs[0].signedUrl,
      garmentImageUrl: signedInputs[1].signedUrl,
      prompt,
    })
    stage = 'runpod-submit'
    const inputValidation = validateTryOnInput(runInput)
    if (!inputValidation.valid) {
      const error = new Error('FitCheck produced an invalid Runpod request shape.')
      error.stage = 'runpod-input-validation'
      error.publicMessage = 'FitCheck could not prepare valid image URLs and prompt text for the endpoint. Re-upload both images and try again.'
      throw error
    }
    let runResult
    try {
      runResult = await requestRunPod({ endpointId, apiKey, operation: 'run', input: runInput })
    } catch {
      const error = new Error('Runpod job submission could not reach the provider.')
      error.runpodOperation = 'run'
      error.runpodStatus = 0
      error.stage = 'runpod-submit-network'
      error.publicMessage = 'FitCheck could not reach Runpod to submit the generation. Check the backend network connection and try again.'
      throw error
    }
    const job = runResult.payload
    const runOutcome = interpretRunPodResponse(runResult.httpStatus, job, { submitting: true })

    if (!['queued', 'processing'].includes(runOutcome.kind)) {
      logRunPodFailure('run', runResult.httpStatus, job, generation.id, runOutcome.category, getInputFieldTypes(runInput))
      const message = runOutcome.message || 'Runpod returned an invalid job submission response. Check the endpoint logs and worker configuration.'
      await supabase.from('generations').update({ status: 'failed', error: message }).eq('id', generation.id)
      return response.status(502).json({ error: message })
    }

    stage = 'generation-record-update'
    const { error: updateError } = await supabase
      .from('generations')
      .update({ runpod_job_id: job.id, status: runOutcome.kind === 'processing' ? 'processing' : 'queued' })
      .eq('id', generation.id)
      .eq('guest_id', guestId)
    if (updateError) throw updateError

    response.status(202).json({ id: generation.id, status: job.status || 'IN_QUEUE' })
  } catch (error) {
    error.stage ||= stage
    error.requestId ||= generationId
    if (supabase && generationId) {
      await supabase.from('generations').update({ status: 'failed', error: getSafeErrorMessage(error) }).eq('id', generationId).eq('guest_id', guestId)
    }
    sendError(response, error)
  }
})

app.get('/api/generations/:id', async (request, response) => {
  let generation
  let stage = 'generation-record-read'
  try {
    const guestId = requireGuestId(request.query.guest_id)
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('generations')
      .select('*')
      .eq('id', request.params.id)
      .eq('guest_id', guestId)
      .single()
    if (error) throw error
    generation = data

    if (generation.runpod_job_id && !['completed', 'failed'].includes(generation.status)) {
      const { endpointId, apiKey } = getRunPodConfig()
      stage = 'runpod-status-poll'
      let statusResult
      try {
        statusResult = await requestRunPod({
          endpointId,
          apiKey,
          operation: 'status',
          jobId: generation.runpod_job_id,
        })
      } catch {
        const error = new Error('Runpod status request could not reach the provider.')
        error.runpodOperation = 'status'
        error.runpodStatus = 0
        error.stage = 'runpod-status-network'
        error.publicMessage = 'FitCheck could not reach Runpod to check this generation. The job may still be running; retry shortly.'
        throw error
      }
      const job = statusResult.payload
      const outcome = interpretRunPodResponse(statusResult.httpStatus, job)

      if (outcome.kind === 'http_error') {
        logRunPodFailure('status', statusResult.httpStatus, job, generation.id, outcome.category)
        const error = new Error('Runpod status request failed.')
        error.runpodOperation = 'status'
        error.runpodStatus = statusResult.httpStatus
        error.stage = 'runpod-status-response'
        error.publicMessage = outcome.message
        throw error
      }

      if (outcome.kind === 'job_failed' || outcome.kind === 'missing_image' || outcome.kind === 'invalid_response' || outcome.kind === 'invalid_status') {
        logRunPodFailure('status-output', statusResult.httpStatus, job, generation.id, outcome.category)
        const message = outcome.message || (outcome.kind === 'missing_image'
          ? 'The endpoint completed without an image result. Verify its output schema returns an image URL or image field.'
          : outcome.kind === 'invalid_status'
            ? 'Runpod returned an unrecognized job status. Check the endpoint logs and its worker status response.'
            : 'The Runpod job failed. Check the endpoint logs for the worker failure.')
        await markGenerationFailed(supabase, generation, guestId, message)
      } else if (outcome.kind === 'image_ready') {
        stage = 'result-image-retrieval'
        const imageResult = await retrieveRunPodImage(outcome.image)
        if (imageResult.kind === 'invalid_url') {
          await markGenerationFailed(supabase, generation, guestId, 'The endpoint returned an invalid image URL. Check the worker output schema.')
        } else if (imageResult.kind === 'network_error') {
          const error = new Error('Generated image retrieval failed.')
          error.stage = 'result-download'
          error.publicMessage = 'Runpod returned an image result, but FitCheck could not retrieve it. Retry shortly or check the provider result URL availability.'
          throw error
        } else if (imageResult.kind !== 'retrieved') {
          await markGenerationFailed(supabase, generation, guestId, 'Runpod returned an image result, but it was empty or could not be retrieved. Check the worker output URL and endpoint logs.')
        } else {
            stage = 'result-storage-upload'
            const outputBlob = imageResult.blob
            const resultPath = `results/${generation.id}.webp`
            const { error: uploadError } = await supabase.storage.from(bucket).upload(resultPath, outputBlob, {
              contentType: imageResult.contentType || 'image/webp',
              upsert: true,
            })
            if (uploadError) throw uploadError
            const { data: updated, error: updateError } = await supabase
              .from('generations')
              .update({ status: 'completed', result_path: resultPath, completed_at: new Date().toISOString(), error: null })
              .eq('id', generation.id)
              .eq('guest_id', guestId)
              .select('*')
              .single()
            if (updateError) throw updateError
            Object.assign(generation, updated)
            stage = 'generation-record-complete'
        }
      } else if (outcome.kind === 'queued' || outcome.kind === 'processing') {
        const { data: updated, error: updateError } = await supabase
          .from('generations')
          .update({ status: outcome.kind === 'processing' ? 'processing' : 'queued' })
          .eq('id', generation.id)
          .eq('guest_id', guestId)
          .select('*')
          .single()
        if (updateError) throw updateError
        Object.assign(generation, updated)
      }
    }

    response.json({
      id: generation.id,
      status: generation.status,
      error: publicGenerationError(generation.error),
      result_url: await signedImageUrl(supabase, generation.result_path),
    })
  } catch (error) {
    error.stage ||= stage
    error.requestId ||= generation?.id
    if (generation) {
      console.error('[generation] Result processing failed:', {
        stage: error.stage,
        requestId: generation.id,
        errorCategory: error?.runpodOperation ? getRunPodFailureCategory(error.runpodStatus) : 'result_processing_failure',
      })
    }
    sendError(response, error)
  }
})

app.get('/api/history', async (request, response) => {
  try {
    const guestId = requireGuestId(request.query.guest_id)
    const supabase = getSupabase()
    const { data: rows, error } = await supabase
      .from('generations')
      .select('id, guest_id, person_path, garment_path, prompt, status, result_path, error, created_at, completed_at')
      .eq('guest_id', guestId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error

    const generations = await Promise.all(rows.map(async (row) => ({
      ...row,
      error: publicGenerationError(row.error),
      person_url: await signedImageUrl(supabase, row.person_path),
      garment_url: await signedImageUrl(supabase, row.garment_path),
      result_url: await signedImageUrl(supabase, row.result_path),
    })))
    response.json({ generations })
  } catch (error) {
    sendError(response, error)
  }
})

export { app }
export default app

if (process.env.VERCEL !== '1' && process.env.FITCHECK_SKIP_LISTEN !== '1') {
  app.listen(port, () => {
    console.log(`FitCheck API running on http://localhost:${port}`)
    try {
      const supabase = getSupabase()
      diagnoseStorageConfiguration(supabase)
        .then((diagnostic) => logStorageDiagnostic('startup configuration', diagnostic))
        .catch(() => console.error('[storage] startup configuration could not be verified', {
          projectHost: new URL(process.env.SUPABASE_URL.trim()).host,
          configuredBucket: bucket,
        }))
    } catch {
      console.error('[storage] startup configuration is incomplete', {
        configuredBucket: bucket,
        supabaseUrlPresent: Boolean(process.env.SUPABASE_URL?.trim()),
        serverKeyPresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
      })
    }
  })
}
