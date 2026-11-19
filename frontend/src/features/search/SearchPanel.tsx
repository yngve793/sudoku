import { useId, useState } from 'react'
import type { SearchMode, SearchNode, SearchTree } from '../../api/types'
import { cellName } from '../game/grid'
import type { GraphItem, TechniqueMap } from './graphModel'
import { SearchGraph } from './SearchGraph'
import { MAX_NODES, canApply, deadReason, nodeLabel } from './searchReducer'

interface SearchPanelProps {
  tree: SearchTree
  node: SearchNode
  selectedCell: number | null
  /** Candidates of the selected cell on the node's board (empty if filled). */
  cellCandidates: readonly number[]
  guessPending: boolean
  autoPlacements: number
  costPerCell: number
  propagating: boolean
  error: string | null
  message: string | null
  onGuess: () => void
  onBranch: () => void
  onErase: () => void
  onDelete: () => void
  onApply: () => void
  onReset: () => void
  onExit: () => void
  onSetMode: (mode: SearchMode) => void
  selectedKey: string
  techniques: TechniqueMap
  /** Implication step being viewed (null = end of the chain). */
  viewStep: number | null
  onSelectItem: (item: GraphItem) => void
  onToggleCollapse: (id: string) => void
  onDismissError: () => void
  /** Full-screen tree page for this game (opened in a new tab). */
  treeUrl?: string
}

function statusText(node: SearchNode): string {
  const reason = deadReason(node)
  if (reason) return `Dead: ${reason}.`
  if (node.status === 'solved') return 'Solved: this branch fills the whole board.'
  return 'Open: no contradiction yet.'
}

export function SearchPanel(props: SearchPanelProps) {
  const { tree, node, selectedCell } = props
  const titleId = useId()
  const [confirmAuto, setConfirmAuto] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [graphOpen, setGraphOpen] = useState(true)
  const graphId = useId()
  // The cost is shown (and confirmed) before auto mode is enabled for the first time.
  const [autoAcknowledged, setAutoAcknowledged] = useState(
    tree.mode === 'auto' || props.autoPlacements > 0,
  )

  const dead = node.status === 'dead'
  const full = tree.nodes.length >= MAX_NODES
  const cellEmpty = selectedCell !== null && props.cellCandidates.length > 0
  const isRoot = node.parent_id === null
  const branchRoom = tree.nodes.length + props.cellCandidates.length <= MAX_NODES
  const cost = props.costPerCell
  const costText = `Auto fills direct implications: −${cost} points per filled cell.`

  function chooseMode(mode: SearchMode) {
    if (mode === tree.mode) return
    if (mode === 'auto' && !autoAcknowledged) {
      setConfirmAuto(true)
      return
    }
    props.onSetMode(mode)
  }

  return (
    <section className="search-panel" aria-labelledby={titleId}>
      <header className="search-panel__header">
        <h2 id={titleId} className="search-panel__title">
          Search
        </h2>
        <fieldset className="segmented search-panel__mode">
          <legend className="visually-hidden">Implications</legend>
          {(['manual', 'auto'] as const).map((mode) => (
            <label key={mode} className="segmented__option">
              <input
                type="radio"
                name={`${titleId}-mode`}
                value={mode}
                checked={tree.mode === mode}
                onChange={() => chooseMode(mode)}
              />
              <span>{mode === 'manual' ? 'Manual' : `Auto (−${cost}/cell)`}</span>
            </label>
          ))}
        </fieldset>
      </header>

      {confirmAuto && (
        <div className="search-panel__confirm" role="alertdialog" aria-label="Enable auto mode">
          <p>{costText}</p>
          <div className="search-panel__row">
            <button
              type="button"
              className="button button--primary button--small"
              onClick={() => {
                setAutoAcknowledged(true)
                setConfirmAuto(false)
                props.onSetMode('auto')
              }}
            >
              Enable auto
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setConfirmAuto(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="search-panel__node" aria-live="polite">
        <span className={`search-status search-status--${node.status}`} aria-hidden="true">
          {dead ? '✗' : node.status === 'solved' ? '✓' : '○'}
        </span>{' '}
        <strong>{nodeLabel(node)}</strong>
        {node.placements.length > 0 && <> · +{node.placements.length}</>} —{' '}
        <span className="search-panel__status">{statusText(node)}</span>
      </p>

      {(tree.mode === 'auto' || props.autoPlacements > 0) && (
        <p className="search-panel__cost">
          Auto placements: <strong>{props.autoPlacements}</strong> (−
          {props.autoPlacements * cost} points)
          {props.propagating && (
            <span className="search-panel__busy"> · finding implications…</span>
          )}
        </p>
      )}

      {props.guessPending && (
        <p className="search-panel__prompt" role="status">
          Guess for {selectedCell === null ? 'the selected cell' : cellName(selectedCell)}: press a
          digit (Esc cancels).
        </p>
      )}
      {props.viewStep !== null && (
        <p className="search-panel__prompt" role="status">
          Viewing{' '}
          {props.viewStep < 0
            ? 'the guess only'
            : `step ${props.viewStep + 1} of ${node.placements.length}`}
          . Guess, branch and digits apply to the end of this chain.
        </p>
      )}
      {props.message && (
        <p className="search-panel__prompt" role="status">
          {props.message}
        </p>
      )}
      {props.error && (
        <p className="search-panel__error" role="alert">
          {props.error}{' '}
          <button type="button" className="link-button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </p>
      )}
      {full && (
        <p className="search-panel__prompt" role="status">
          The tree is full ({MAX_NODES} nodes). Delete a branch to explore further.
        </p>
      )}

      <div className="search-actions" role="toolbar" aria-label="Search actions">
        <button
          type="button"
          className={`button button--secondary button--small${props.guessPending ? ' is-active' : ''}`}
          onClick={props.onGuess}
          disabled={dead || full || !cellEmpty}
          aria-pressed={props.guessPending}
          aria-keyshortcuts="G"
        >
          Guess…
        </button>
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={props.onBranch}
          disabled={dead || full || !cellEmpty || !branchRoom}
          aria-keyshortcuts="B"
        >
          Branch on all
          {cellEmpty && ` (${props.cellCandidates.length})`}
        </button>
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={props.onErase}
          disabled={isRoot}
          aria-keyshortcuts="Backspace"
        >
          Erase
        </button>
        <button
          type="button"
          className="button button--primary button--small"
          onClick={props.onApply}
          disabled={!canApply(node)}
          title={dead ? 'Dead branches cannot be applied' : undefined}
        >
          Apply branch
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={props.onDelete}
          disabled={isRoot}
        >
          Delete branch
        </button>
        {confirmReset ? (
          <span className="search-panel__row">
            <button
              type="button"
              className="button button--danger button--small"
              onClick={() => {
                setConfirmReset(false)
                props.onReset()
              }}
            >
              Confirm reset
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setConfirmReset(false)}
            >
              Keep tree
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setConfirmReset(true)}
          >
            Reset tree
          </button>
        )}
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={props.onExit}
          aria-keyshortcuts="S"
        >
          Exit search
        </button>
      </div>

      <div className="search-panel__graph-head">
        <h3 className="search-panel__subtitle">Tree</h3>
        {props.treeUrl && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => window.open(props.treeUrl, '_blank', 'noopener')}
          >
            Open tree in new tab
          </button>
        )}
        <button
          type="button"
          className="button button--ghost button--small search-panel__graph-toggle"
          aria-expanded={graphOpen}
          aria-controls={graphId}
          onClick={() => setGraphOpen((o) => !o)}
        >
          {graphOpen ? 'Hide tree' : 'Show tree'}
        </button>
      </div>
      <div id={graphId} hidden={!graphOpen}>
        {graphOpen && (
          <SearchGraph
            tree={tree}
            selectedKey={props.selectedKey}
            techniques={props.techniques}
            onSelectItem={props.onSelectItem}
            onToggleCollapse={props.onToggleCollapse}
          />
        )}
      </div>
    </section>
  )
}
