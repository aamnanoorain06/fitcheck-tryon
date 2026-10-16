import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))

test('Vercel prototype uses a separate build command and Express framework preset', () => {
  assert.equal(packageJson.scripts.dev, 'concurrently "node server.mjs" "vite --host 0.0.0.0"')
  assert.equal(packageJson.scripts.build, 'vite build')
  assert.equal(packageJson.scripts['build:vercel'], 'vite build --mode vercel')
  assert.equal(vercelConfig.framework, 'express')
  assert.equal(vercelConfig.buildCommand, 'npm run build:vercel')
})

test('Vercel prototype rewrites only the root to the Vite entry and does not catch API paths', () => {
  assert.deepEqual(vercelConfig.rewrites, [
    { source: '/', destination: '/_fitcheck/index.html' },
  ])
  assert.equal(vercelConfig.rewrites.some(({ source }) => source.startsWith('/api')), false)
  assert.equal(vercelConfig.rewrites.some(({ source }) => source.includes('(.*)')), false)
})

test('Vercel prototype marks private API responses as non-cacheable', () => {
  const apiHeaders = vercelConfig.headers.find(({ source }) => source === '/api/:path*')
  assert.ok(apiHeaders)
  assert.deepEqual(apiHeaders.headers, [{ key: 'Cache-Control', value: 'private, no-store' }])
})
