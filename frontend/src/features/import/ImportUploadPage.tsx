import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert } from '../../components/Alert'
import { useImportFlow } from './importSession'
import { recognizeErrorMessage } from './importErrors'
import { checkFile, preprocessImage } from './preprocess'
import { UploadProgress } from './UploadProgress'
import { useRecognize } from './useRecognize'

/** First image file among dropped/pasted items. */
function firstImage(files: FileList | null | undefined): File | null {
  if (!files?.length) return null
  return [...files].find((f) => f.type.startsWith('image/')) ?? files[0] ?? null
}

export function ImportUploadPage() {
  const { begin } = useImportFlow()
  const navigate = useNavigate()
  const recognize = useRecognize()
  const { run, fail, busy } = recognize
  const [preparing, setPreparing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const working = preparing || busy

  const handleFile = useCallback(
    async (file: File | null) => {
      if (!file || working) return
      const problem = checkFile(file)
      if (problem) {
        fail(problem.message)
        return
      }
      setPreparing(true)
      let photo
      try {
        photo = await preprocessImage(file)
      } catch (error) {
        fail(recognizeErrorMessage(error))
        return
      } finally {
        setPreparing(false)
      }
      const recognition = await run(photo.blob, null)
      if (!recognition) return
      begin(photo, recognition)
      void navigate('review')
    },
    [working, fail, run, begin, navigate],
  )

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const file = firstImage(event.clipboardData?.files)
      if (!file) return
      event.preventDefault()
      void handleFile(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [handleFile])

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void handleFile(firstImage(event.dataTransfer.files))
  }

  const phase = recognize.phase

  return (
    <div className="page import-page">
      <header className="page__header">
        <h1 className="page__title">Import from photo</h1>
        <p className="page__lead">
          Photograph a printed Sudoku, even a half-solved one. We read the printed digits and your
          handwritten entries, then you check them before playing.
        </p>
      </header>

      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}${working ? ' dropzone--busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!working) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-busy={working}
      >
        {working ? (
          <UploadProgress preparing={preparing} phase={phase} onCancel={recognize.cancel} />
        ) : (
          <>
            <p className="dropzone__title">Drop a photo here</p>
            <p className="dropzone__hint">or paste one (Ctrl+V / ⌘V), or choose a file</p>
            <div className="dropzone__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => pickerRef.current?.click()}
              >
                Choose photo
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => cameraRef.current?.click()}
              >
                Take photo
              </button>
            </div>
          </>
        )}
        <input
          ref={pickerRef}
          type="file"
          accept="image/*"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Photo file"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null
            e.target.value = ''
            void handleFile(file)
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Camera photo"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null
            e.target.value = ''
            void handleFile(file)
          }}
        />
      </div>

      {phase.kind === 'error' && (
        <Alert tone={phase.cancelled ? 'info' : 'error'}>{phase.message}</Alert>
      )}

      <section className="import-tips" aria-labelledby="import-tips-title">
        <h2 id="import-tips-title" className="section-title">
          For the best result
        </h2>
        <ul>
          <li>Fit the whole grid in the frame, as straight-on as you can.</li>
          <li>Use even light and avoid shadows or glare across the digits.</li>
          <li>Hold still so the digits are sharp.</li>
        </ul>
        <p className="import-tips__privacy">
          Privacy: your photo is resized and stripped of location and camera data on this device
          before upload. Our server reads it in memory and never stores it. Imported games are not
          ranked on the leaderboard.
        </p>
      </section>

      <p>
        <Link to="/">Back to home</Link>
      </p>
    </div>
  )
}
