import { useEffect, useRef, useState } from 'react'
import { getBrowserSupabase } from './lib/supabase'
import './App.css'

const DEFAULT_PROMPT = "Take the person from image 1 and dress them in the item shown in image 2, keeping the person's pose, facial identity, hair, body proportions, lighting, and background unchanged, only replacing or adding the item with realistic color, fabric, and fit for a seamless, photorealistic try-on."
const BUCKET = 'try on'
const GUEST_KEY = 'fitcheck.guest_id'
const ACTIVE_GENERATION_KEY = 'fitcheck.active_generation'

function UploadIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15.5v3A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-3" /></svg>
}

function SparkleIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></svg>
}

function ImagePlaceholder() {
  return <svg viewBox="0 0 88 88" fill="none" aria-hidden="true"><rect x="8" y="8" width="72" height="72" rx="20" /><circle cx="34" cy="33" r="7" /><path d="m16 66 19-19 12 12 8-8 17 17" /><path d="m59 28 1.5 4.5L65 34l-4.5 1.5L59 40l-1.5-4.5L53 34l4.5-1.5L59 28Z" /></svg>
}

function getOrCreateGuestId() {
  let id = localStorage.getItem(GUEST_KEY)
  if (!id) {
    if (typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID()
    } else {
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }
    localStorage.setItem(GUEST_KEY, id)
  }
  return id
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.')
    error.status = response.status
    throw error
  }
  return data
}

function App() {
  const [guestId] = useState(getOrCreateGuestId)
  const [personPhoto, setPersonPhoto] = useState(null)
  const [garmentPhoto, setGarmentPhoto] = useState(null)
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [activeGenerationId, setActiveGenerationId] = useState(() => sessionStorage.getItem(ACTIVE_GENERATION_KEY))
  const [status, setStatus] = useState(() => sessionStorage.getItem(ACTIVE_GENERATION_KEY) ? 'processing' : 'empty')
  const [error, setError] = useState('')
  const [resultUrl, setResultUrl] = useState('')
  const [history, setHistory] = useState([])
  const [selectedHistoryItem, setSelectedHistoryItem] = useState(null)
  const [view, setView] = useState(() => window.location.hash === '#history' ? 'history' : 'playground')
  const [isGenerating, setIsGenerating] = useState(false)
  const objectUrls = useRef(new Set())

  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url))
    objectUrls.current.clear()
  }, [])

  useEffect(() => {
    const syncRoute = () => setView(window.location.hash === '#history' ? 'history' : 'playground')
    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])

  useEffect(() => {
    if (!activeGenerationId) return undefined
    let cancelled = false
    let attempts = 0
    let timer

    const poll = async () => {
      if (cancelled) return
      attempts += 1
      try {
        const query = new URLSearchParams({ guest_id: guestId })
        const data = await readJson(await fetch(`/api/generations/${activeGenerationId}?${query}`))
        if (cancelled) return
        setStatus(data.status)
        setError(data.error || '')
        if (data.result_url) setResultUrl(data.result_url)

        if (data.status === 'completed' || data.status === 'failed') {
          sessionStorage.removeItem(ACTIVE_GENERATION_KEY)
          setActiveGenerationId('')
          return
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError.message)
          setStatus('error')
          if (pollError.status === 404) {
            sessionStorage.removeItem(ACTIVE_GENERATION_KEY)
            setActiveGenerationId('')
            return
          }
        }
      }

      if (!cancelled && attempts < 75) timer = window.setTimeout(poll, 4000)
      else if (!cancelled) {
        setError('This generation is taking longer than expected. It may still finish; check your history again shortly.')
        setStatus('timeout')
      }
    }

    poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeGenerationId, guestId])

  useEffect(() => {
    if (view !== 'history') return
    let cancelled = false
    const loadHistory = async () => {
      setError('')
      try {
        const query = new URLSearchParams({ guest_id: guestId })
        const data = await readJson(await fetch(`/api/history?${query}`))
        if (!cancelled) setHistory(data.generations || [])
      } catch (loadError) {
        if (!cancelled) setError(loadError.message)
      }
    }
    loadHistory()
    return () => { cancelled = true }
  }, [view, guestId])

  function handlePhotoFile(file, setPhoto, label, input) {
    if (!file) return
    setError('')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setStatus('error')
      setError(`${label} must be an image file. Please choose a JPG, PNG, or WebP.`)
      if (input) input.value = ''
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus('error')
      setError(`${label} must be 10 MB or smaller.`)
      if (input) input.value = ''
      return
    }
    const preview = URL.createObjectURL(file)
    objectUrls.current.add(preview)
    setPhoto({ file, preview })
    setStatus('empty')
  }

  function removePhoto(photo, setPhoto, inputId) {
    if (photo?.preview) {
      URL.revokeObjectURL(photo.preview)
      objectUrls.current.delete(photo.preview)
    }
    setPhoto(null)
    setError('')
    setStatus('empty')
    const input = document.getElementById(inputId)
    if (input) input.value = ''
  }

  async function uploadPhoto(file, kind) {
    const signedUpload = await readJson(await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_id: guestId, kind, contentType: file.type, size: file.size }),
    }))
    const supabase = getBrowserSupabase()
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .uploadToSignedUrl(signedUpload.path, signedUpload.token, file, { contentType: file.type, upsert: false })
    if (uploadError) {
      const status = Number(uploadError.statusCode ?? uploadError.status)
      if (status === 404) {
        throw new Error('The configured Supabase Storage bucket was not found. Check that the browser and server use the same project and bucket ID.')
      }
      if (status === 401 || status === 403) {
        throw new Error('Supabase rejected the photo upload. Check the signed-upload configuration and try again.')
      }
      throw new Error('The photo could not be uploaded to private storage. Check the Supabase storage configuration and try again.')
    }
    return signedUpload.path
  }

  async function handleGenerate(event) {
    event.preventDefault()
    if (!personPhoto || !garmentPhoto) {
      setStatus('error')
      setError('Add both a person photo and a garment photo to continue.')
      return
    }

    setError('')
    setResultUrl('')
    setStatus('processing')
    setIsGenerating(true)
    try {
      const [personPath, garmentPath] = await Promise.all([
        uploadPhoto(personPhoto.file, 'person'),
        uploadPhoto(garmentPhoto.file, 'garment'),
      ])
      const created = await readJson(await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guest_id: guestId,
          person_path: personPath,
          garment_path: garmentPath,
          prompt: prompt.trim() || DEFAULT_PROMPT,
        }),
      }))
      sessionStorage.setItem(ACTIVE_GENERATION_KEY, created.id)
      setStatus(created.status === 'IN_PROGRESS' ? 'processing' : 'queued')
      setActiveGenerationId(created.id)
    } catch (generateError) {
      setStatus('error')
      setError(generateError.message || 'The AI service could not process your request.')
    } finally {
      setIsGenerating(false)
    }
  }

  function renderUploadCard({ id, title, hint, photo, setPhoto }) {
    return <div className="upload-card">
      <div className="upload-card-heading"><div><label className="field-title" htmlFor={id}>{title}</label><p className="field-hint">{hint}</p></div><span className="required-tag">Required</span></div>
      <input id={id} className="file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => handlePhotoFile(event.target.files?.[0], setPhoto, title, event.target)} />
      {photo ? <div className="photo-preview"><img src={photo.preview} alt={`Preview of ${title.toLowerCase()}`} /><div className="preview-caption"><span className="preview-check" aria-hidden="true">✓</span><span className="file-name" title={photo.file.name}>{photo.file.name}</span><button className="remove-photo" type="button" aria-label={`Remove ${title.toLowerCase()}`} onClick={() => removePhoto(photo, setPhoto, id)}>Remove</button></div></div> : <label className="dropzone" htmlFor={id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); handlePhotoFile(event.dataTransfer.files?.[0], setPhoto, title, document.getElementById(id)) }}><span className="upload-icon"><UploadIcon /></span><span className="dropzone-title">Drop your image here</span><span className="dropzone-action">or <span>browse files</span></span><span className="file-types">JPG, PNG or WebP · up to 10 MB</span></label>}
    </div>
  }

  function startOver() {
    setError('')
    setResultUrl('')
    setStatus('empty')
  }

  return <div className="app-shell">
    <header className="site-header">
      <a className="brand" href="#home" aria-label="FitCheck home"><span className="brand-mark">F</span><span>fitcheck<span className="brand-period">.</span></span></a>
      <nav aria-label="Main navigation"><a className={`nav-link ${view === 'playground' ? 'active' : ''}`} href="#try-on">Try on</a><a className={`nav-link ${view === 'history' ? 'active' : ''}`} href="#history">History</a></nav>
      <div className="header-note"><span className="status-dot" /> Your personal fitting room</div>
    </header>

    <main id="home">
      <section className="intro" id="try-on"><div className="eyebrow"><span /> THE FUTURE OF FITTING</div><h1>AI Virtual <span>Try-On</span></h1><p className="intro-copy">See how it looks before you buy. Upload a photo of yourself and the piece you love to get started.</p></section>

      {view === 'history' ? <section className="history-panel" aria-labelledby="history-heading">
        <div className="panel-heading"><div><span className="step-label">YOUR STUDIO <span className="step-line" /></span><h2 id="history-heading">Generation history</h2></div><a className="text-link" href="#try-on">New try-on <span aria-hidden="true">→</span></a></div>
        {error && <p className="form-error" role="alert"><span aria-hidden="true">!</span>{error}</p>}
        {history.length ? <div className="history-grid">{history.map((item) => <button className="history-card" type="button" key={item.id} onClick={() => setSelectedHistoryItem(item)}><div className="history-images">{item.person_url && <img src={item.person_url} alt="Person input" />}{item.garment_url && <img src={item.garment_url} alt="Garment input" />}{item.result_url && <img src={item.result_url} alt="Try-on result" />}</div><div className="history-card-copy"><span className={`history-status ${item.status}`}>{item.status}</span><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></div></button>)}</div> : <div className="history-empty"><span className="empty-illustration"><ImagePlaceholder /></span><h3>No try-ons yet</h3><p>Your completed and in-progress generations will appear here.</p><a className="generate-button" href="#try-on">Create your first try-on <span className="button-arrow">→</span></a></div>}
      </section> : <form className="workspace" onSubmit={handleGenerate} noValidate>
        <section className="uploads-panel" aria-labelledby="upload-heading">
          <div className="panel-heading"><div><span className="step-label">STEP 01 <span className="step-line" /></span><h2 id="upload-heading">Add your photos</h2></div><span className="privacy-note"><span aria-hidden="true">⌑</span> Private &amp; secure</span></div>
          <div className="upload-grid">{renderUploadCard({ id: 'person-photo', title: 'Person Photo', hint: 'A clear, full-body photo works best', photo: personPhoto, setPhoto: setPersonPhoto })}{renderUploadCard({ id: 'garment-photo', title: 'Garment Photo', hint: 'Choose the item you want to try on', photo: garmentPhoto, setPhoto: setGarmentPhoto })}</div>
          <div className="prompt-field"><label className="field-title" htmlFor="prompt-input">Prompt</label><textarea id="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder={DEFAULT_PROMPT} /></div>
          {['error', 'failed', 'timeout'].includes(status) && <div className="error-actions"><p className="form-error" role="alert"><span aria-hidden="true">!</span>{error || 'Generation failed. Please try again.'}</p><button className="text-link" type="button" onClick={startOver}>Try again <span aria-hidden="true">↻</span></button></div>}
          <div className="form-footer"><p>Photos upload securely to private storage for processing.</p><button className="generate-button" type="submit" disabled={isGenerating || ['queued', 'processing'].includes(status)}>{isGenerating || ['queued', 'processing'].includes(status) ? <span className="button-spinner" /> : <SparkleIcon />}{isGenerating ? 'Uploading photos…' : status === 'queued' || status === 'processing' ? 'Generation in progress…' : 'Generate Try-On'}{!isGenerating && !['queued', 'processing'].includes(status) && <span className="button-arrow" aria-hidden="true">→</span>}</button></div>
        </section>
        <section className="result-panel" aria-labelledby="result-heading" aria-busy={['queued', 'processing'].includes(status)}>
          <div className="result-heading"><div><span className="step-label">STEP 02 <span className="step-line" /></span><h2 id="result-heading">Your try-on</h2></div><span className="soon-tag">{status === 'completed' ? 'READY' : status === 'queued' || status === 'processing' ? status.toUpperCase() : 'PREVIEW'}</span></div>
          <div className={`result-stage ${status}`} aria-live="polite">{status === 'completed' && resultUrl ? <div className="generated-result"><img src={resultUrl} alt="AI-generated virtual try-on" /><a className="generate-button" href={resultUrl} download="fitcheck-try-on.webp">Download result <span className="button-arrow">↓</span></a></div> : ['queued', 'processing'].includes(status) || isGenerating ? <div className="result-message"><span className="large-spinner" /><h3>{isGenerating ? 'Uploading your photos' : status === 'queued' ? 'Your try-on is queued' : 'Creating your try-on'}</h3><p>This can take 30–120 seconds. You can return to your history while it runs.</p></div> : status === 'error' || status === 'failed' || status === 'timeout' ? <div className="result-message result-error"><span className="result-symbol" aria-hidden="true">!</span><h3>Not quite ready</h3><p>{error}</p></div> : <div className="result-message"><span className="empty-illustration"><ImagePlaceholder /></span><h3>Your look will appear here</h3><p>Add both photos to prepare your virtual try-on.</p></div>}</div>
          <p className="result-footnote"><span aria-hidden="true">✦</span> AI-powered styling, made personal</p>
        </section>
      </form>}

      <footer className="page-footer"><span>Made for your next great fit.</span><span>FITCHECK <span className="footer-separator">/</span> PHASE 01</span></footer>
    </main>

    {selectedHistoryItem && <div className="modal-backdrop" role="presentation" onClick={() => setSelectedHistoryItem(null)}><section className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-modal-heading" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" aria-label="Close details" onClick={() => setSelectedHistoryItem(null)}>×</button><h2 id="history-modal-heading">Try-on details</h2><p className="history-modal-date">{new Date(selectedHistoryItem.created_at).toLocaleString()} · {selectedHistoryItem.status}</p><div className="modal-images">{[selectedHistoryItem.person_url, selectedHistoryItem.garment_url, selectedHistoryItem.result_url].filter(Boolean).map((url) => <img key={url} src={url} alt="Generation image" />)}</div><h3>Prompt</h3><p>{selectedHistoryItem.prompt}</p>{selectedHistoryItem.result_url && <a className="generate-button" href={selectedHistoryItem.result_url} download="fitcheck-try-on.webp">Download result</a>}{selectedHistoryItem.error && <p className="form-error">{selectedHistoryItem.error}</p>}</section></div>}
  </div>
}

export default App
