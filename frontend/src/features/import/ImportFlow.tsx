import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet } from 'react-router'
import type { Recognition } from '../../api/types'
import type { ImportFlowContext, ImportSession } from './importSession'
import type { PreparedPhoto } from './preprocess'

/** Route shell for `/import` and `/import/review`: holds the photo in memory only. */
export function ImportFlow() {
  const [session, setSession] = useState<ImportSession | null>(null)

  // Revoke each photo URL when it is replaced or the flow unmounts.
  const photoUrl = session?.photoUrl
  useEffect(() => {
    if (!photoUrl) return
    return () => URL.revokeObjectURL(photoUrl)
  }, [photoUrl])

  const begin = useCallback((photo: PreparedPhoto, recognition: Recognition) => {
    setSession({ photo, photoUrl: URL.createObjectURL(photo.blob), recognition })
  }, [])
  const updateRecognition = useCallback((recognition: Recognition) => {
    setSession((s) => (s ? { ...s, recognition } : s))
  }, [])
  const clear = useCallback(() => setSession(null), [])

  const context = useMemo<ImportFlowContext>(
    () => ({ session, begin, updateRecognition, clear }),
    [session, begin, updateRecognition, clear],
  )
  return <Outlet context={context} />
}
