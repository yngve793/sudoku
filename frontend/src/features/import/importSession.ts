import { useOutletContext } from 'react-router'
import type { Recognition } from '../../api/types'
import type { PreparedPhoto } from './preprocess'

/**
 * The photo being imported. Lives only in React state under the `/import`
 * route (never in storage): leaving the flow or reloading drops it.
 */
export interface ImportSession {
  photo: PreparedPhoto
  /** Object URL of `photo.blob` for display; revoked when the session ends. */
  photoUrl: string
  recognition: Recognition
}

export interface ImportFlowContext {
  session: ImportSession | null
  begin: (photo: PreparedPhoto, recognition: Recognition) => void
  updateRecognition: (recognition: Recognition) => void
  clear: () => void
}

export function useImportFlow(): ImportFlowContext {
  return useOutletContext<ImportFlowContext>()
}

/** Test/tuning knobs (no wall-clock waits in unit tests). */
export const importTimings = {
  /** Debounce before `POST /imports/check` after an edit. */
  checkDebounceMs: 400,
  /** Retry delay after a 429 from `/imports/check`. */
  checkRetryMs: 3000,
}
