interface ControlsProps {
  notesMode: boolean
  canUndo: boolean
  canRedo: boolean
  disabled: boolean
  checking: boolean
  /** A search tree already exists (the button resumes it). */
  hasSearchTree?: boolean
  onUndo: () => void
  onRedo: () => void
  onErase: () => void
  onToggleNotes: () => void
  onHint: () => void
  onCheck: () => void
  onSearch?: () => void
}

function Icon({ path }: { path: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  )
}

const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  erase:
    'M20 20H7L3 16a1.5 1.5 0 0 1 0-2L13 4a1.5 1.5 0 0 1 2 0l5 5a1.5 1.5 0 0 1 0 2l-9 9M6 11l7 7',
  notes: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  hint: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2Z',
  check: 'M20 6 9 17l-5-5',
  search: 'M12 3v5M12 8 6 14M12 8l6 6M6 14v4M18 14v4M4 20h4M16 20h4',
}

export function Controls(props: ControlsProps) {
  const { disabled } = props
  return (
    <div className="controls" role="toolbar" aria-label="Game controls">
      <button
        type="button"
        className="control"
        onClick={props.onUndo}
        disabled={disabled || !props.canUndo}
        aria-keyshortcuts="Control+Z"
      >
        <Icon path={ICONS.undo} />
        <span>Undo</span>
      </button>
      <button
        type="button"
        className="control"
        onClick={props.onRedo}
        disabled={disabled || !props.canRedo}
        aria-keyshortcuts="Control+Shift+Z"
      >
        <Icon path={ICONS.redo} />
        <span>Redo</span>
      </button>
      <button
        type="button"
        className="control"
        onClick={props.onErase}
        disabled={disabled}
        aria-keyshortcuts="Backspace"
      >
        <Icon path={ICONS.erase} />
        <span>Erase</span>
      </button>
      <button
        type="button"
        className={`control${props.notesMode ? ' control--active' : ''}`}
        onClick={props.onToggleNotes}
        disabled={disabled}
        aria-pressed={props.notesMode}
        aria-keyshortcuts="N"
      >
        <Icon path={ICONS.notes} />
        <span>Notes {props.notesMode ? 'on' : 'off'}</span>
      </button>
      <button
        type="button"
        className="control"
        onClick={props.onHint}
        disabled={disabled}
        aria-keyshortcuts="H"
      >
        <Icon path={ICONS.hint} />
        <span>Hint</span>
      </button>
      <button
        type="button"
        className="control"
        onClick={props.onCheck}
        disabled={disabled || props.checking}
      >
        <Icon path={ICONS.check} />
        <span>{props.checking ? 'Checking…' : 'Check'}</span>
      </button>
      {props.onSearch && (
        <button
          type="button"
          className="control"
          onClick={props.onSearch}
          disabled={disabled}
          aria-keyshortcuts="S"
        >
          <Icon path={ICONS.search} />
          <span>{props.hasSearchTree ? 'Search…' : 'Search'}</span>
        </button>
      )}
    </div>
  )
}
