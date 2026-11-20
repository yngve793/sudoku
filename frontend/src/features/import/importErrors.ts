import { ApiError, isAbortError } from '../../api/client'
import { errorMessage } from '../../lib/errors'
import { PhotoInputError } from './preprocess'

/** Player-facing text for every error `POST /imports/recognize` declares. */
export function recognizeErrorMessage(error: unknown, withCorners = false): string {
  if (error instanceof PhotoInputError) return error.message
  if (isAbortError(error)) return 'Upload cancelled.'
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'image_too_large':
        return 'This photo is too large for the server (at most 10 MB and 40 megapixels). Try a smaller photo.'
      case 'unsupported_image':
        return "This file type isn't supported. Use a JPEG, PNG or WebP photo."
      case 'image_unreadable':
        return "We couldn't read this image; it may be damaged. Try taking the photo again."
      case 'no_grid_found':
        return withCorners
          ? 'No Sudoku grid was found inside those corners. Place each handle on an outer corner of the grid and try again.'
          : "We couldn't find a Sudoku grid in this photo. Make sure the whole grid is visible, flat, well lit and in focus, then try again."
      case 'recognition_unavailable':
        return 'Photo recognition is busy or unavailable right now. Please try again in a moment.'
    }
    if (error.status === 413) return 'This photo is too large for the server. Try a smaller photo.'
    if (error.status === 415)
      return "This file type isn't supported. Use a JPEG, PNG or WebP photo."
    if (error.status === 429)
      return "You've sent a lot of photos in a short time. Please wait a minute and try again."
    if (error.status === 503)
      return 'Photo recognition is busy or unavailable right now. Please try again in a moment.'
  }
  return errorMessage(error, 'Something went wrong while reading the photo. Please try again.')
}

/**
 * Text for `POST /games/import` failures (422 codes from PLAN.md §5.6, 429
 * `rate_limited` from `IMPORT_GAME_RATE_LIMIT`). The review state is kept, so a
 * 429 is retryable with the same Start button.
 */
export function startErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'puzzle_inconsistent':
        return 'The printed digits contradict each other. Fix the marked cells first.'
      case 'no_solution':
        return 'These printed digits have no solution. A given is probably misread.'
      case 'multiple_solutions':
        return 'These printed digits allow more than one solution. A given is probably missing or marked as handwritten.'
      case 'givens_modified':
        return 'A handwritten entry overwrites a printed given. Check the cell kinds.'
      case 'rate_limited':
        return "You've started several games from photos in a short time. Your corrections are kept; wait a minute, then press Start game again."
    }
    if (error.status === 429)
      return 'Too many games started in a short time. Your corrections are kept; wait a minute, then press Start game again.'
  }
  return errorMessage(error, 'Could not start the game. Please try again.')
}
