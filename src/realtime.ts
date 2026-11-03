import type { GameState } from './types'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: number
  sentAt: number
}

type RealtimeHandlers = {
  onState: (state: GameState) => void
  onStatus: (status: ConnectionStatus) => void
  onLatency: (latency: number) => void
  onClockOffset: (offset: number) => void
  onRestored: (durationMs: number) => void
  onAuthLost: () => void
  onError: (message: string) => void
}

let fallbackId = 0

function createId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  fallbackId += 1
  return `${Date.now().toString(36)}-${fallbackId.toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export class GameRealtimeClient {
  private socket: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private retryTimer = 0
  private disconnectStatusTimer = 0
  private heartbeatTimer = 0
  private reconnectDelay = 500
  private wasConnected = false
  private outageStartedAt = 0
  private awaitingState = false
  private awaitingRestore = false
  private closed = false
  private sequence = 0
  private readonly handlers: RealtimeHandlers

  constructor(handlers: RealtimeHandlers) {
    this.handlers = handlers
  }

  connect() {
    this.closed = false
    this.openSocket()
  }

  close() {
    this.closed = true
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.disconnectStatusTimer)
    window.clearInterval(this.heartbeatTimer)
    this.rejectPending('Connection closed.')
    this.socket?.close()
    this.socket = null
  }

  get isConnected() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async login(email: string, password: string) {
    const response = await this.request('auth.login', { email, password })
    if (typeof response.token === 'string') sessionStorage.setItem('teacher-roulette-session', response.token)
    if (response.state) this.handlers.onState(response.state as GameState)
    return response
  }

  async logout() {
    if (this.isConnected && sessionStorage.getItem('teacher-roulette-session')) {
      try {
        await this.request('auth.logout', {})
      } catch {
        this.handlers.onError('Server logout could not be acknowledged; the session will expire automatically.')
      }
    }
    sessionStorage.removeItem('teacher-roulette-session')
  }

  async command(action: string, payload: Record<string, unknown> = {}) {
    const actionId = createId()
    return this.request('admin.command', {
      actionId,
      action,
      payload,
      clientSentAt: Date.now(),
      clientSequence: ++this.sequence,
    })
  }

  private async request(type: string, payload: Record<string, unknown>) {
    if (!this.isConnected) throw new Error('Disconnected. The command was not sent.')
    const requestId = createId()
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Server did not acknowledge the command in time.'))
      }, 5000)
      this.pending.set(requestId, { resolve, reject, timer, sentAt: Date.now() })
      this.socket?.send(JSON.stringify({ type, requestId, ...payload }))
    })
  }

  private openSocket() {
    if (this.closed) return
    this.handlers.onStatus(this.wasConnected ? 'reconnecting' : 'connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.reconnectDelay = 500
      this.wasConnected = true
      this.awaitingState = true
      const token = sessionStorage.getItem('teacher-roulette-session')
      this.awaitingRestore = Boolean(token)
      socket.send(JSON.stringify({ type: 'state.get' }))
      socket.send(JSON.stringify({ type: 'heartbeat', clientSentAt: Date.now(), requestId: createId() }))
      if (token) {
        void this.request('auth.restore', { token })
          .then(() => {
            this.awaitingRestore = false
            this.finishConnection(socket)
          })
          .catch(() => {
            sessionStorage.removeItem('teacher-roulette-session')
            this.handlers.onAuthLost()
            this.awaitingRestore = false
            this.finishConnection(socket)
          })
      }
      this.heartbeatTimer = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'heartbeat', clientSentAt: Date.now(), requestId: createId() }))
      }, 5000)
    })

    socket.addEventListener('message', (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        this.handlers.onError('Received an invalid synchronization message.')
        return
      }

      if ((message.type === 'state' || message.type === 'connection') && message.state) {
        if (typeof message.serverTime === 'number') this.handlers.onClockOffset(message.serverTime - Date.now())
        this.handlers.onState(message.state as GameState)
        this.awaitingState = false
        this.finishConnection(socket)
        return
      }
      if (message.type === 'heartbeat' && typeof message.clientSentAt === 'number') {
        const receivedAt = Date.now()
        this.handlers.onLatency(receivedAt - message.clientSentAt)
        if (typeof message.serverTime === 'number') {
          this.handlers.onClockOffset(message.serverTime - ((receivedAt + message.clientSentAt) / 2))
        }
        return
      }
      if (message.type === 'ack' && typeof message.requestId === 'string') {
        const pending = this.pending.get(message.requestId)
        if (!pending) return
        window.clearTimeout(pending.timer)
        this.pending.delete(message.requestId)
        this.handlers.onLatency(Date.now() - pending.sentAt)
        if (message.ok) pending.resolve(message)
        else pending.reject(new Error(String(message.error ?? 'Action rejected.')))
        if (message.state) {
          this.handlers.onState(message.state as GameState)
          this.awaitingState = false
          this.finishConnection(socket)
        }
      }
      if (message.type === 'error') this.handlers.onError(String(message.error ?? 'Synchronization error.'))
    })

    socket.addEventListener('close', () => {
      window.clearInterval(this.heartbeatTimer)
      this.rejectPending('Connection lost. Reconnecting; no action was confirmed.')
      if (this.closed) {
        this.handlers.onStatus('disconnected')
        return
      }
      this.handlers.onStatus(
        this.outageStartedAt && Date.now() - this.outageStartedAt >= 10000
          ? 'disconnected'
          : 'reconnecting',
      )
      if (!this.outageStartedAt) {
        this.outageStartedAt = Date.now()
        this.disconnectStatusTimer = window.setTimeout(() => {
          if (!this.closed && this.outageStartedAt) this.handlers.onStatus('disconnected')
        }, 10000)
      }
      const delay = this.reconnectDelay
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000)
      this.retryTimer = window.setTimeout(() => this.openSocket(), delay)
    })

    socket.addEventListener('error', () => {
      this.handlers.onStatus('reconnecting')
    })
  }

  private finishConnection(socket: WebSocket) {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN || this.awaitingState || this.awaitingRestore) return
    const outageDuration = this.outageStartedAt ? Date.now() - this.outageStartedAt : 0
    window.clearTimeout(this.disconnectStatusTimer)
    this.disconnectStatusTimer = 0
    this.handlers.onStatus('connected')
    if (outageDuration) {
      socket.send(JSON.stringify({ type: 'connection.reconnected', durationMs: outageDuration }))
      this.handlers.onRestored(outageDuration)
      this.outageStartedAt = 0
    }
  }

  private rejectPending(message: string) {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.pending.delete(id)
    }
  }
}
