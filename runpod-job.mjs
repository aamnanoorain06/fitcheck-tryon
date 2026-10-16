const numericInputPattern = /supposed to be numbers|numbers?.{0,30}alphabet|numeric.{0,30}(string|text|alphabet)/i

export function buildTryOnInput({ requestId, personImageUrl, garmentImageUrl, prompt }) {
  return {
    request_id: requestId,
    model_img: personImageUrl,
    cloth_img: garmentImageUrl,
    output_format: 'webp',
    prompt,
    premium_user: true,
    swap_type: 'tryon',
    mode: 'regular',
  }
}

export function validateTryOnInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, reason: 'input_not_object' }
  for (const field of ['model_img', 'cloth_img']) {
    let url
    try {
      url = new URL(input[field])
    } catch {
      return { valid: false, reason: `${field}_not_url` }
    }
    if (url.protocol !== 'https:') return { valid: false, reason: `${field}_not_https` }
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { valid: false, reason: 'prompt_not_text' }
  return { valid: true }
}

export function getRunPodOutput(job) {
  return Array.isArray(job?.output) ? job.output[0] : job?.output
}

export function getOutputImage(job) {
  const output = getRunPodOutput(job)
  return output?.image || output?.url || null
}

export function getRunPodOutputFailure(job) {
  const output = getRunPodOutput(job)
  if (!output || typeof output !== 'object') return null
  const status = Number(output.status_code ?? output.statusCode)
  if (output.error || (Number.isInteger(status) && status >= 400)) {
    return { output, status: Number.isInteger(status) && status >= 400 ? status : 400 }
  }
  return null
}

export function getRunPodFailureCategory(status, payload = {}) {
  const detail = [payload.detail, payload.message, payload.error]
    .filter((value) => typeof value === 'string')
    .join(' ')
  if ((status === 400 || status === 422) && numericInputPattern.test(detail)) return 'numeric_input_type_mismatch'
  if (status === 401 || status === 403) return 'authorization_rejected'
  if (status === 404) return 'endpoint_or_resource_not_found'
  if (status === 400 || status === 422) return 'input_rejected'
  if (status >= 500) return 'provider_or_worker_error'
  return 'unknown_provider_error'
}

export function getRunPodFailureMessage(status, payload = {}) {
  const detail = [payload.detail, payload.message, payload.error]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (status === 401 || status === 403) {
    if (/unauthorized access to endpoint|not authorized.*endpoint|endpoint.*not authorized/.test(detail)) {
      return 'RunPod denied this API key access to the configured endpoint. Verify RUNPOD_ENDPOINT_ID belongs to the account for RUNPOD_API_KEY, or grant that account access to the endpoint.'
    }
    if (/invalid api key|invalid.*api key/.test(detail)) {
      return 'RunPod rejected the API key. Update RUNPOD_API_KEY with a valid key from the RunPod account that owns this endpoint, then restart the backend.'
    }
    return 'RunPod rejected the API key. Update RUNPOD_API_KEY with a valid key from the RunPod account that owns this endpoint, then restart the backend.'
  }
  if (status === 404) {
    return 'RunPod could not find this endpoint. Verify RUNPOD_ENDPOINT_ID in the server environment, then restart the backend.'
  }
  if ((status === 400 || status === 422) && numericInputPattern.test(detail)) {
    return 'RunPod reports a numeric input type mismatch. The worker schema is not present in this project, so verify its documented numeric fields and types before changing the request payload.'
  }
  if (status === 400 || status === 422) {
    return 'RunPod rejected the generation input. Check the endpoint worker input schema and accepted image format.'
  }
  return 'RunPod did not accept the generation job. Check the endpoint status and server-side RunPod configuration.'
}

export function interpretRunPodResponse(httpStatus, payload, { submitting = false } = {}) {
  if (httpStatus < 200 || httpStatus >= 300) {
    return { kind: 'http_error', category: getRunPodFailureCategory(httpStatus, payload), message: getRunPodFailureMessage(httpStatus, payload) }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'invalid_response', category: 'invalid_json_response' }
  }
  if (submitting && (typeof payload.id !== 'string' || !payload.id)) {
    return { kind: 'invalid_response', category: 'missing_job_id' }
  }

  const status = typeof payload.status === 'string' ? payload.status.toUpperCase() : ''
  if (status === 'IN_QUEUE') return { kind: 'queued', status }
  if (status === 'IN_PROGRESS') return { kind: 'processing', status }
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
    return { kind: 'job_failed', status, category: 'job_terminal_failure' }
  }
  if (status !== 'COMPLETED') return { kind: 'invalid_status', category: 'unknown_job_status' }

  const outputFailure = getRunPodOutputFailure(payload)
  if (outputFailure) {
    const category = getRunPodFailureCategory(outputFailure.status, { error: outputFailure.output.error })
    return {
      kind: 'job_failed',
      status,
      category,
      message: getRunPodFailureMessage(outputFailure.status, { error: outputFailure.output.error }),
      outputKeys: Object.keys(outputFailure.output).slice(0, 20),
    }
  }

  const image = getOutputImage(payload)
  if (typeof image !== 'string' || !image.trim()) {
    return {
      kind: 'missing_image',
      status,
      category: 'completed_without_image',
      outputKeys: getRunPodOutput(payload) && typeof getRunPodOutput(payload) === 'object'
        ? Object.keys(getRunPodOutput(payload)).slice(0, 20)
        : [],
    }
  }
  return { kind: 'image_ready', status, image }
}

export async function retrieveRunPodImage(imageUrl, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const dataUri = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(imageUrl || ''))
  if (dataUri) {
    const bytes = Buffer.from(dataUri[2], 'base64')
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { kind: 'invalid_body' }
    return { kind: 'retrieved', blob: new Blob([bytes], { type: dataUri[1] }), contentType: dataUri[1] }
  }

  let parsedUrl
  try {
    parsedUrl = new URL(imageUrl)
  } catch {
    return { kind: 'invalid_url' }
  }
  if (parsedUrl.protocol !== 'https:') return { kind: 'invalid_url' }

  let response
  try {
    response = await fetchImpl(parsedUrl, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { kind: 'network_error' }
  }
  if (!response.ok) return { kind: 'http_error', status: response.status }

  let blob
  try {
    blob = await response.blob()
  } catch {
    return { kind: 'invalid_body' }
  }
  if (!blob.size) return { kind: 'empty_body' }
  return { kind: 'retrieved', blob, contentType: response.headers.get('content-type') || blob.type || null }
}

export async function requestRunPod({ endpointId, apiKey, operation, jobId, input, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (!['run', 'status'].includes(operation)) throw new TypeError('Unsupported RunPod operation.')
  const baseUrl = `https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}`
  const url = operation === 'run'
    ? `${baseUrl}/run`
    : `${baseUrl}/status/${encodeURIComponent(jobId)}`
  const init = {
    method: operation === 'run' ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, ...(operation === 'run' ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (operation === 'run') init.body = JSON.stringify({ input })
  const response = await fetchImpl(url, init)
  const payload = await response.json().catch(() => null)
  return { httpStatus: response.status, payload }
}
