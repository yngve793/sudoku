import type { RecognizePhase } from './useRecognize'

interface UploadProgressProps {
  preparing: boolean
  phase: RecognizePhase
  onCancel: () => void
  /** Verb for the server step ("Reading the grid…" by default). */
  readingText?: string
}

/** Preparing → uploading (with %) → reading; cancellable once the upload starts. */
export function UploadProgress({
  preparing,
  phase,
  onCancel,
  readingText = 'Reading the grid…',
}: UploadProgressProps) {
  const uploading = phase.kind === 'uploading'
  const pct = uploading && phase.progress !== null ? Math.round(phase.progress * 100) : null
  const text = preparing
    ? 'Preparing photo…'
    : uploading
      ? pct === null
        ? 'Uploading…'
        : `Uploading… ${pct}%`
      : readingText
  return (
    <div className="upload-progress">
      <p className="upload-progress__text" role="status">
        {text}
      </p>
      <div
        className={`progress${pct === null ? ' progress--indeterminate' : ''}`}
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={text}
      >
        <span className="progress__bar" style={{ width: `${pct ?? 100}%` }} />
      </div>
      {!preparing && (
        <button type="button" className="button button--ghost button--small" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  )
}
