import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { after, before, test } from 'node:test'

const previousSkipFlag = process.env.FITCHECK_SKIP_LISTEN
process.env.FITCHECK_SKIP_LISTEN = '1'
const { app } = await import('../server.mjs')
if (previousSkipFlag === undefined) delete process.env.FITCHECK_SKIP_LISTEN
else process.env.FITCHECK_SKIP_LISTEN = previousSkipFlag

let server
let baseUrl

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (!server?.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
})

function sendRequest(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    const request = httpRequest(`${baseUrl}${path}`, { method, headers }, (response) => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { responseBody += chunk })
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: responseBody ? JSON.parse(responseBody) : null })
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

async function withoutExternalFetch(operation) {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('Unexpected external fetch during validation-only request')
  }
  try {
    const result = await operation()
    assert.equal(fetchCalls, 0, 'validation-only requests must not make external fetch calls')
    return result
  } finally {
    globalThis.fetch = originalFetch
  }
}

const validGuestId = '123e4567-e89b-42d3-a456-426614174000'

test('health endpoint responds from the exported Express handler', async () => {
  const response = await sendRequest('/api/health')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true, name: 'fitcheck-tryon' })
})

test('generation validation rejects missing and incorrectly typed inputs before external calls', async () => {
  await withoutExternalFetch(async () => {
    const missing = await sendRequest('/api/generate', { method: 'POST' })
    assert.equal(missing.status, 400)
    assert.deepEqual(missing.body, { error: 'A valid guest_id is required.' })

    const invalidGuestId = await sendRequest('/api/generate', {
      method: 'POST',
      body: { guest_id: 42, person_path: 'person', garment_path: 'garment' },
    })
    assert.equal(invalidGuestId.status, 400)
    assert.deepEqual(invalidGuestId.body, { error: 'A valid guest_id is required.' })

    const invalidPaths = await sendRequest('/api/generate', {
      method: 'POST',
      body: { guest_id: validGuestId, person_path: ['person'], garment_path: null },
    })
    assert.equal(invalidPaths.status, 400)
    assert.deepEqual(invalidPaths.body, { error: 'Upload a person photo and garment photo before generating.' })

    const missingPaths = await sendRequest('/api/generate', {
      method: 'POST',
      body: { guest_id: validGuestId },
    })
    assert.equal(missingPaths.status, 400)
    assert.deepEqual(missingPaths.body, { error: 'Upload a person photo and garment photo before generating.' })
  })
})

test('upload validation rejects missing guest ID and invalid field types before external calls', async () => {
  await withoutExternalFetch(async () => {
    const missingGuestId = await sendRequest('/api/upload-url', {
      method: 'POST',
      body: { kind: 'person', contentType: 'image/png', size: 8 },
    })
    assert.equal(missingGuestId.status, 400)
    assert.deepEqual(missingGuestId.body, { error: 'A valid guest_id is required.' })

    const invalidTypes = await sendRequest('/api/upload-url', {
      method: 'POST',
      body: { guest_id: validGuestId, kind: ['person'], contentType: {}, size: '8' },
    })
    assert.equal(invalidTypes.status, 400)
    assert.deepEqual(invalidTypes.body, { error: 'Choose a person or garment image in JPG, PNG, or WebP format.' })

    const invalidSizeType = await sendRequest('/api/upload-url', {
      method: 'POST',
      body: { guest_id: validGuestId, kind: 'person', contentType: 'image/png', size: '8' },
    })
    assert.equal(invalidSizeType.status, 400)
    assert.deepEqual(invalidSizeType.body, { error: 'Images must be smaller than 10 MB.' })
  })
})
