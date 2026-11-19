import { useEffect, useRef } from 'react'
import { GameSyncHost, openChannel, type SnapshotInput, type SyncCommand } from './sync'

/**
 * Game-tab side of the tree-tab sync: broadcasts `snapshot` whenever it
 * changes (pass a memoised object) and runs tree-tab commands via `onCommand`.
 * Says `bye` on `pagehide` and unmount so tree tabs turn read-only.
 */
export function useSearchSyncHost(
  gameId: number,
  snapshot: SnapshotInput,
  onCommand: (command: SyncCommand) => void,
) {
  const hostRef = useRef<GameSyncHost | null>(null)
  const commandRef = useRef(onCommand)
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    commandRef.current = onCommand
    snapshotRef.current = snapshot
  })

  useEffect(() => {
    const channel = openChannel(gameId)
    if (!channel) return
    const host = new GameSyncHost(channel, (command) => commandRef.current(command))
    hostRef.current = host
    host.publish(snapshotRef.current, true)
    const onHide = () => host.bye()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      host.close()
      hostRef.current = null
    }
  }, [gameId])

  useEffect(() => {
    hostRef.current?.publish(snapshot)
  }, [snapshot])
}
