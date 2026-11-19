/**
 * API types, derived from the backend's OpenAPI schema (`npm run gen:api`
 * regenerates `schema.gen.ts` from `../backend/openapi.json`). Do not hand-edit
 * shapes here: re-export or narrow the generated ones so the contract cannot drift.
 */
import type { components } from './schema.gen'

type Schemas = components['schemas']

export type Difficulty = Schemas['Difficulty']
export type LeaderboardPeriod = Schemas['LeaderboardPeriod']
export type GameStatus = Schemas['GameStatus']

/** All difficulties, easiest first. The check below fails to compile if the enum changes. */
export const DIFFICULTIES = [
  'beginner',
  'easy',
  'medium',
  'hard',
  'expert',
  'master',
  'extreme',
] as const satisfies readonly Difficulty[]
/** Compile-time guard: `true` only if every Difficulty appears in DIFFICULTIES. */
export type AllDifficultiesListed =
  Exclude<Difficulty, (typeof DIFFICULTIES)[number]> extends never ? true : never
export const ALL_DIFFICULTIES_LISTED: AllDifficultiesListed = true

/** Every error response: `{"detail": str, "code": str}`. */
export type ApiErrorBody = Schemas['ErrorOut']

/** Error `code` values the frontend reacts to explicitly. */
export type ApiErrorCode =
  | 'not_authenticated'
  | 'invalid_token'
  | 'invalid_credentials'
  | 'email_not_verified'
  | 'invalid_username'
  | 'username_taken'
  | 'username_not_allowed'
  | 'validation_error'
  | 'rate_limited'
  | 'not_found'
  | 'version_conflict'
  | 'givens_modified'
  | 'game_not_in_progress'
  | 'no_hint_available'
  | 'board_not_solved'
  | 'puzzle_unavailable'

// ---------- auth ----------
export type RegisterRequest = Schemas['RegisterIn']
export type LoginRequest = Schemas['LoginIn']
export type ResetPasswordRequest = Schemas['ResetPasswordIn']
export type MessageResponse = Schemas['MessageOut']
export type TokenResponse = Schemas['TokenOut']
export type User = Schemas['UserOut']
export type Me = Schemas['MeOut']
export type UserStats = Schemas['UserStatsOut']

// ---------- games ----------
export type Game = Schemas['GameOut']
export type CompletedGame = Schemas['CompletedGameOut']
export type ScoreBreakdown = Schemas['ScoreBreakdownOut']
export type GameUpdateRequest = Schemas['GameUpdateIn']
/** Cell index ("0".."80") → sorted candidate digits. Empty lists are omitted. */
export type NotesWire = Game['notes']
export type HintCosts = Schemas['HintCosts']
export type Hint = Schemas['HintOut']
export type HintStage = Hint['stage']
export type CheckResponse = Schemas['CheckOut']

// ---------- search mode (PLAN.md §5.5) ----------
export type SearchTree = Schemas['SearchTree']
export type SearchNode = Schemas['SearchNode']
export type SearchChoice = Schemas['SearchChoice']
export type SearchPlacement = Schemas['SearchPlacement']
export type SearchMode = SearchTree['mode']
export type SearchNodeStatus = SearchNode['status']
export type SearchCosts = Schemas['SearchCosts']
export type Contradiction = Schemas['Contradiction']
export type ContradictionKind = Contradiction['kind']
export type PropagateResponse = Schemas['PropagateOut']
export type PropagatePlacement = Schemas['PropagationPlacementOut']

// ---------- scores / leaderboard ----------
export type ScoresMe = Schemas['ScoresMeOut']
export type BestScore = Schemas['BestScore']
export type ScoreHistoryItem = Schemas['ScoreHistoryItem']
export type Leaderboard = Schemas['LeaderboardOut']
export type LeaderboardEntry = Schemas['LeaderboardEntry']
export type LeaderboardMe = Schemas['LeaderboardMeOut']
