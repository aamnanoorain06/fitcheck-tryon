import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTryOnInput,
  getOutputImage,
  getRunPodFailureCategory,
  getRunPodOutputFailure,
  interpretRunPodResponse,
  retrieveRunPodImage,
  requestRunPod,
  validateTryOnInput,
} from '../runpod-job.mjs'

const numericWorkerError = 'Inputs which are supposed to be numbers are in alphabet'

test('validates the known FitCheck image URL and prompt shapes only', () => {
  assert.deepEqual(validateTryOnInput({
    model_img: 'https://storage.example/signed-person',
    cloth_img: 'https://storage.example/signed-garment',
    prompt: 'Try on the garment',
  }), { valid: true })
  assert.equal(validateTryOnInput({ model_img: 'http://storage.example/person', cloth_img: 'https://storage.example/garment', prompt: 'x' }).valid, false)
  assert.equal(validateTryOnInput({ model_img: 'https://storage.example/person', cloth_img: 'https://storage.example/garment', prompt: 42 }).reason, 'prompt_not_text')
})

test('locks down the current FitCheck payload without inferring worker-only numeric fields', () => {
  const input = buildTryOnInput({
    requestId: 'tryon-correlation-id',
    personImageUrl: 'https://storage.example/person',
    garmentImageUrl: 'https://storage.example/garment',
    prompt: 'Try on this garment',
  })
  assert.deepEqual(Object.keys(input), [
    'request_id', 'model_img', 'cloth_img', 'output_format', 'prompt', 'premium_user', 'swap_type', 'mode',
  ])
  assert.equal(typeof input.request_id, 'string')
  assert.equal(typeof input.model_img, 'string')
  assert.equal(typeof input.cloth_img, 'string')
  assert.equal(typeof input.output_format, 'string')
  assert.equal(typeof input.prompt, 'string')
  assert.equal(typeof input.premium_user, 'boolean')
  assert.equal(typeof input.swap_type, 'string')
  assert.equal(typeof input.mode, 'string')
})

test('accepts documented asynchronous queue response', () => {
  assert.deepEqual(interpretRunPodResponse(200, { id: 'job-123', status: 'IN_QUEUE' }, { submitting: true }), {
    kind: 'queued',
    status: 'IN_QUEUE',
  })
})

test('classifies running jobs without treating them as complete', () => {
  assert.equal(interpretRunPodResponse(200, { id: 'job-123', status: 'IN_PROGRESS' }).kind, 'processing')
})

test('accepts completed image URL output in object or array form', () => {
  const byImage = { status: 'COMPLETED', output: [{ image: 'https://images.example/result.webp' }] }
  const byUrl = { status: 'COMPLETED', output: { url: 'https://images.example/result.webp' } }
  assert.equal(getOutputImage(byImage), 'https://images.example/result.webp')
  assert.equal(interpretRunPodResponse(200, byImage).kind, 'image_ready')
  assert.equal(interpretRunPodResponse(200, byUrl).kind, 'image_ready')
})

test('recognizes worker validation error nested in completed output', () => {
  const job = { status: 'COMPLETED', output: [{ error: numericWorkerError, status_code: 400 }] }
  const result = interpretRunPodResponse(200, job)
  assert.equal(getRunPodOutputFailure(job).status, 400)
  assert.equal(result.kind, 'job_failed')
  assert.equal(result.category, 'numeric_input_type_mismatch')
  assert.match(result.message, /worker schema is not present/i)
  assert.equal(getRunPodFailureCategory(400, { error: numericWorkerError }), 'numeric_input_type_mismatch')
})

test('rejects completed responses that have no recognized image field', () => {
  const result = interpretRunPodResponse(200, { status: 'COMPLETED', output: [{ status_code: 200 }] })
  assert.equal(result.kind, 'missing_image')
  assert.equal(result.category, 'completed_without_image')
})

test('distinguishes HTTP rejection, terminal failure, and malformed responses', () => {
  assert.equal(interpretRunPodResponse(401, { title: 'Unauthorized' }).category, 'authorization_rejected')
  assert.equal(interpretRunPodResponse(200, { status: 'FAILED' }).kind, 'job_failed')
  assert.equal(interpretRunPodResponse(200, null, { submitting: true }).category, 'invalid_json_response')
  assert.equal(interpretRunPodResponse(200, { status: 'UNKNOWN' }).category, 'unknown_job_status')
  assert.equal(interpretRunPodResponse(200, {}, { submitting: true }).category, 'missing_job_id')
})

test('mocked request submits current payload and parses provider response without real inference', async () => {
  let seen
  const response = await requestRunPod({
    endpointId: 'endpoint-test',
    apiKey: 'test-only-key',
    operation: 'run',
    input: { model_img: 'https://storage.example/person', cloth_img: 'https://storage.example/garment' },
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ id: 'job-mock', status: 'IN_QUEUE' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(seen.url, 'https://api.runpod.ai/v2/endpoint-test/run')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.Authorization, 'Bearer test-only-key')
  assert.deepEqual(JSON.parse(seen.init.body), {
    input: { model_img: 'https://storage.example/person', cloth_img: 'https://storage.example/garment' },
  })
  assert.equal(response.httpStatus, 200)
  assert.equal(interpretRunPodResponse(response.httpStatus, response.payload, { submitting: true }).kind, 'queued')
})

test('mocked status polling handles provider HTTP errors without leaking details into a category', async () => {
  const response = await requestRunPod({
    endpointId: 'endpoint-test',
    apiKey: 'test-only-key',
    operation: 'status',
    jobId: 'job-mock',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.runpod.ai/v2/endpoint-test/status/job-mock')
      assert.equal(init.method, 'GET')
      return new Response(JSON.stringify({ title: 'Unauthorized', detail: 'private provider detail' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const result = interpretRunPodResponse(response.httpStatus, response.payload)
  assert.equal(result.kind, 'http_error')
  assert.equal(result.category, 'authorization_rejected')
  assert.equal(JSON.stringify(result).includes('private provider detail'), false)
})

test('retrieves a mocked HTTPS image response without exposing its URL', async () => {
  let requestedUrl
  const result = await retrieveRunPodImage('https://images.example/private-result.webp?token=do-not-log', {
    fetchImpl: async (url) => {
      requestedUrl = url
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      })
    },
  })
  assert.equal(requestedUrl.hostname, 'images.example')
  assert.equal(result.kind, 'retrieved')
  assert.equal(result.blob.size, 3)
  assert.equal(result.contentType, 'image/webp')
})

test('accepts an inline image data URI from a recognized image output field', async () => {
  const result = await retrieveRunPodImage('data:image/png;base64,AQID')
  assert.equal(result.kind, 'retrieved')
  assert.equal(result.contentType, 'image/png')
  assert.equal(result.blob.size, 3)
})

test('classifies image retrieval HTTP, invalid URL, empty body, and network failures', async () => {
  assert.equal((await retrieveRunPodImage('http://images.example/result.webp')).kind, 'invalid_url')
  assert.equal((await retrieveRunPodImage('https://images.example/result.webp', {
    fetchImpl: async () => new Response('not found', { status: 404 }),
  })).kind, 'http_error')
  assert.equal((await retrieveRunPodImage('https://images.example/result.webp', {
    fetchImpl: async () => new Response(new Blob([]), { status: 200 }),
  })).kind, 'empty_body')
  assert.equal((await retrieveRunPodImage('https://images.example/result.webp', {
    fetchImpl: async () => { throw new Error('private network details') },
  })).kind, 'network_error')
})
