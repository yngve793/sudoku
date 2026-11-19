/**
 * In-memory BroadcastChannel for tests: every channel with the same name gets
 * the message (asynchronously, structured-cloned), except the sender itself,
 * like the real API.
 */
export class MockBroadcastChannel {
  static channels: MockBroadcastChannel[] = []
  /** Every message posted on any channel: [name, message]. */
  static log: [string, unknown][] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  readonly name: string

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.channels.push(this)
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('closed')
    const data: unknown = structuredClone(message)
    MockBroadcastChannel.log.push([this.name, data])
    for (const other of MockBroadcastChannel.channels) {
      if (other === this || other.closed || other.name !== this.name) continue
      queueMicrotask(() => other.onmessage?.({ data }))
    }
  }

  close(): void {
    this.closed = true
  }

  static reset(): void {
    MockBroadcastChannel.channels = []
    MockBroadcastChannel.log = []
  }

  static sent(type?: string): unknown[] {
    return MockBroadcastChannel.log
      .map(([, m]) => m)
      .filter((m) => !type || (m as { type?: string }).type === type)
  }
}
