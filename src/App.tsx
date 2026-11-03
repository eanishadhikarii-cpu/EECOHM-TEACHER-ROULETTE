import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Activity,
  BadgeCheck,
  CircleDollarSign,
  Crown,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Shield,
  Sparkles,
  Swords,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { createInitialState } from './data'
import { GameRealtimeClient, type ConnectionStatus } from './realtime'
import { formatStake, getTeacherById } from './gameLogic'
import type { GameState, Teacher } from './types'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function App() {
  const [state, setState] = useState<GameState>(() => createInitialState())
  const [isAdminLoggedIn, setIsAdminLoggedIn] = useState<boolean>(() => Boolean(sessionStorage.getItem('teacher-roulette-session')))
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [latencyStats, setLatencyStats] = useState({ average: 0, maximum: 0, samples: 0 })
  const [serverClockOffset, setServerClockOffset] = useState(0)
  const [reconnectTimeMs, setReconnectTimeMs] = useState<number | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [isIos] = useState(() => /iphone|ipad|ipod/i.test(navigator.userAgent))
  const clientRef = useRef<GameRealtimeClient | null>(null)

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }

    const client = new GameRealtimeClient({
      onState: (nextState) => {
        setState((current) => nextState.revision >= current.revision ? nextState : current)
        setConnectionError('')
      },
      onStatus: (status) => {
        setConnectionStatus(status)
        if (status === 'connected') setConnectionError('')
      },
      onLatency: (value) => {
        setLatencyMs(value)
        setLatencyStats((current) => ({
          average: Math.round(((current.average * current.samples) + value) / (current.samples + 1)),
          maximum: Math.max(current.maximum, value),
          samples: current.samples + 1,
        }))
      },
      onClockOffset: setServerClockOffset,
      onRestored: (durationMs) => {
        setReconnectTimeMs(durationMs)
        setConnectionError('Synchronization restored.')
      },
      onAuthLost: () => setIsAdminLoggedIn(false),
      onError: setConnectionError,
    })
    clientRef.current = client
    client.connect()
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
    return () => {
      client.close()
      clientRef.current = null
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
    }
  }, [])

  const handleLogin = async () => {
    try {
      await clientRef.current?.login(loginForm.email, loginForm.password)
      setIsAdminLoggedIn(true)
      setConnectionError('')
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Login failed.')
    }
  }

  const handleLogout = async () => {
    await clientRef.current?.logout()
    setIsAdminLoggedIn(false)
  }

  const sendCommand = async (action: string, payload: Record<string, unknown> = {}) => {
    if (connectionStatus !== 'connected') throw new Error('Disconnected. Game actions are disabled until synchronization returns.')
    if (!clientRef.current) throw new Error('Synchronization connection is unavailable.')
    return clientRef.current.command(action, payload)
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route
          path="/admin"
          element={isAdminLoggedIn
            ? <AdminDashboard
                state={state}
                sendCommand={sendCommand}
                onLogout={handleLogout}
                connectionStatus={connectionStatus}
                latencyMs={latencyMs}
                latencyStats={latencyStats}
                reconnectTimeMs={reconnectTimeMs}
                serverClockOffset={serverClockOffset}
                connectionError={connectionError}
                isIos={isIos}
                installPrompt={installPrompt}
                onInstallPromptConsumed={() => setInstallPrompt(null)}
              />
            : <LoginScreen
                loginForm={loginForm}
                setLoginForm={setLoginForm}
                onLogin={handleLogin}
                connectionStatus={connectionStatus}
                error={connectionError}
              />}
        />
        <Route path="/audience" element={<AudienceScreen state={state} connectionStatus={connectionStatus} serverClockOffset={serverClockOffset} />} />
      </Routes>
    </BrowserRouter>
  )
}

function LoginScreen({
  loginForm,
  setLoginForm,
  onLogin,
  connectionStatus,
  error,
}: {
  loginForm: { email: string; password: string }
  setLoginForm: Dispatch<SetStateAction<{ email: string; password: string }>>
  onLogin: () => Promise<void>
  connectionStatus: ConnectionStatus
  error: string
}) {
  return (
    <div className="login-shell">
      <div className="login-panel">
        <div className={`login-badge connection-${connectionStatus}`}>
          <Shield size={18} /> {connectionStatus.toUpperCase()} · administrator login
        </div>
        <h1>TEACHER ROULETTE</h1>
        <p>Event control panel</p>
        <p className="demo-warning">Login is verified by the game server. Configure server-only credentials before use.</p>
        <label>
          Email
          <input value={loginForm.email} onChange={(event) => setLoginForm({ ...loginForm, email: event.target.value })} />
        </label>
        <label>
          Password
          <input type="password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="primary-button" onClick={onLogin} disabled={connectionStatus !== 'connected'}>Unlock admin controls</button>
      </div>
    </div>
  )
}

function useServerNow(state: GameState, offsetMs: number) {
  const [serverNow, setServerNow] = useState(state.serverTime)
  useEffect(() => {
    if (!state.spin) return
    const timer = window.setInterval(() => setServerNow(Date.now() + offsetMs), 100)
    return () => window.clearInterval(timer)
  }, [state.spin, offsetMs])
  return serverNow
}

function getCountdown(spin: GameState['spin'], serverNow: number) {
  if (!spin || spin.phase !== 'selection') return null
  const effectiveNow = spin.pausedAt ?? serverNow
  const maximumSeconds = Math.ceil(spin.durationMs / 1000)
  return Math.min(maximumSeconds, Math.max(0, Math.ceil((spin.deadlineAt - effectiveNow) / 1000)))
}

function WheelDisplay({ state, serverClockOffset, compact = false }: {
  state: GameState
  serverClockOffset: number
  compact?: boolean
}) {
  const activeTeachers = state.teachers
  const wheelGradient = `conic-gradient(${activeTeachers
    .map((teacher, index) => {
      const start = (360 / activeTeachers.length) * index
      const end = (360 / activeTeachers.length) * (index + 1)
      return `${teacher.color} ${start}deg ${end}deg`
    })
    .join(', ')})`
  const riskColors = ['#ff5d73', '#ffd166', '#00d2a3']
  const spin = state.spin
  const serverNow = useServerNow(state, serverClockOffset)
  const animationKey = spin ? `${spin.actionId}:${spin.phase}` : ''
  const [animation, setAnimation] = useState({ key: '', delay: '0s' })
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!spin) {
        setAnimation({ key: '', delay: '0s' })
        return
      }
      setAnimation((current) => current.key === animationKey
        ? current
        : { key: animationKey, delay: `${(spin.startedAt - (Date.now() + serverClockOffset)) / 1000}s` })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [animationKey, spin, serverClockOffset])
  const animationDelay = animation.key === animationKey
    ? animation.delay
    : spin ? `${(spin.startedAt - state.serverTime) / 1000}s` : '0s'
  const countdown = getCountdown(spin, serverNow)
  const animationFor = (wheel: 'main' | 'risk') => spin?.wheel === wheel ? spin : null
  const wheelStyle = (wheel: 'main' | 'risk'): CSSProperties => {
    const wheelSpin = animationFor(wheel)
    const preview = wheelSpin?.phase === 'selection'
    const stopping = wheelSpin?.phase === 'decelerating'
    const rotation = wheel === 'main' ? state.outerWheelRotation : state.innerWheelRotation
    return {
      transform: `rotate(${rotation}deg)`,
      '--wheel-start': `${wheelSpin?.fromRotation ?? rotation}deg`,
      '--wheel-end': `${wheelSpin?.toRotation ?? rotation}deg`,
      animationName: preview ? 'wheel-preview' : stopping ? 'wheel-stop' : 'none',
      animationDuration: preview ? '1s' : stopping ? `${wheelSpin.durationMs}ms` : undefined,
      animationTimingFunction: preview ? 'linear' : stopping ? 'cubic-bezier(0.12, 0.72, 0.22, 1)' : undefined,
      animationIterationCount: preview ? 'infinite' : '1',
      animationFillMode: stopping ? 'both' : undefined,
      animationDelay: wheelSpin ? animationDelay : '0s',
      animationPlayState: state.pausedWheel === wheel ? 'paused' : 'running',
    } as CSSProperties
  }

  return (
    <div className={`wheel-wrap ${compact ? 'admin-wheel-wrap' : ''}`}>
      <div className="wheel-pointer" />
      <div
        key={`outer-${state.outerSpinSequence}`}
        className="wheel teacher-wheel"
        style={{ ...wheelStyle('main'), background: wheelGradient }}
      >
        {activeTeachers.map((teacher, index) => {
          const angle = (360 / activeTeachers.length) * (index + 0.5)
          return (
            <div
              key={teacher.id}
              className="teacher-label"
              style={{ transform: `rotate(${angle}deg) translateY(-45%) rotate(${-angle}deg)` }}
            >
              {teacher.name}
            </div>
          )
        })}
      </div>
      <div
        key={`inner-${state.innerSpinSequence}`}
        className="wheel inner-wheel"
        style={{
          ...wheelStyle('risk'),
          background: `conic-gradient(${riskColors[0]} 0deg 120deg, ${riskColors[1]} 120deg 240deg, ${riskColors[2]} 240deg 360deg)`,
        }}
      >
        {([0, 3, 4] as const).map((multiplier, index) => {
          const angle = index * 120 + 60
          return <div key={multiplier} className="inner-label" style={{ transform: `rotate(${angle}deg) translateY(-39%) rotate(${-angle}deg)` }}>{multiplier}X</div>
        })}
      </div>
      <div className="center-spin" aria-hidden="true">
        {spin?.phase === 'selection' && countdown !== null ? countdown : spin?.phase === 'decelerating' ? 'LOCK' : 'SPIN'}
      </div>
    </div>
  )
}

function CountdownPanel({ state, serverClockOffset }: { state: GameState; serverClockOffset: number }) {
  const serverNow = useServerNow(state, serverClockOffset)
  const spin = state.spin
  if (!spin) return <div className="countdown-panel"><span>SELECTION WINDOW</span><strong>15 seconds</strong></div>
  const countdown = getCountdown(spin, serverNow)
  const spinOutcome = spin.wheel === 'main'
    ? getTeacherById(state.teachers, spin.resultId ?? spin.selectedId)?.name
    : spin.resultId ?? spin.selectedId
  return (
    <div className={`countdown-panel ${state.pausedWheel ? 'is-paused' : ''}`} role="timer" aria-live="off">
      <span>{spin.wheel === 'main' ? 'MAIN WHEEL' : 'RISK WHEEL'} · {spin.phase === 'selection' ? state.pausedWheel ? 'PAUSED' : 'SELECTION OPEN' : 'SELECTION LOCKED'}</span>
      <strong>{spin.phase === 'selection' ? `${countdown} SEC` : 'SLOWING'}</strong>
      <small>{spin.phase === 'selection'
        ? spin.selectedId
          ? `Operator selection: ${spin.wheel === 'main' ? getTeacherById(state.teachers, spin.selectedId)?.name ?? 'Unknown' : `${spin.selectedId}X`}`
          : 'No selection · random outcome at zero'
        : `${spin.resultMode === 'random' ? 'Random result' : 'Operator-controlled result'}: ${spin.wheel === 'main' ? spinOutcome ?? '—' : `${spinOutcome ?? '—'}X`}`}</small>
    </div>
  )
}

function AdminDashboard({
  state,
  sendCommand,
  onLogout,
  connectionStatus,
  latencyMs,
  latencyStats,
  reconnectTimeMs,
  serverClockOffset,
  connectionError,
  isIos,
  installPrompt,
  onInstallPromptConsumed,
}: {
  state: GameState
  sendCommand: (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>
  onLogout: () => Promise<void>
  connectionStatus: ConnectionStatus
  latencyMs: number | null
  latencyStats: { average: number; maximum: number; samples: number }
  reconnectTimeMs: number | null
  serverClockOffset: number
  connectionError: string
  isIos: boolean
  installPrompt: InstallPromptEvent | null
  onInstallPromptConsumed: () => void
}) {
  const [activeSection, setActiveSection] = useState('dashboard')
  const [actionError, setActionError] = useState('')
  const [stakeEdit, setStakeEdit] = useState({ value: String(state.currentStake), source: state.currentStake })
  const stakeDraft = stakeEdit.source === state.currentStake ? stakeEdit.value : String(state.currentStake)
  const currentRound = state.currentRound
  const isRoundActive = currentRound?.status === 'in-progress'
  const connected = connectionStatus === 'connected'
  const serverNow = useServerNow(state, serverClockOffset)
  const mainSelection = state.spin?.wheel === 'main' ? state.spin.selectedId : null
  const riskSelection = state.spin?.wheel === 'risk' ? state.spin.selectedId : null

  const runCommand = (action: string, payload: Record<string, unknown> = {}, message = 'Action failed.') => {
    void sendCommand(action, payload)
      .then(() => setActionError(''))
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : message))
  }

  const updateStake = () => {
    const stake = Number(stakeDraft)
    if (!Number.isInteger(stake) || stake < state.settings.minimumStake || stake > state.settings.maximumStake) {
      setActionError(`Stake must be a whole number from ${state.settings.minimumStake} to ${state.settings.maximumStake}.`)
      return
    }
    runCommand('admin.state.update', { state: { ...state, currentStake: stake } }, 'Could not update stake.')
  }

  const startRound = () => runCommand('round.start', { stake: state.currentStake }, 'Could not start round.')
  const select = (selection: string | number) => runCommand('spin.select', { selection: String(selection) }, 'Could not update selection.')
  const handleInstall = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    onInstallPromptConsumed()
  }
  const navTo = (section: string) => {
    setActiveSection(section)
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const stats = useMemo(() => [
    { label: 'Rounds played', value: String(state.history.length), icon: Activity },
    { label: 'Current stake', value: formatStake(currentRound?.originalStake ?? state.currentStake), icon: CircleDollarSign },
    { label: 'Potential payout', value: formatStake(currentRound?.originalStake ? currentRound.originalStake * Math.max(state.settings.matchMultiplier, 4) : 0), icon: BadgeCheck },
    { label: 'Manual results', value: String(state.auditLog.length), icon: Shield },
  ], [state.history.length, state.auditLog.length, state.currentStake, state.settings.matchMultiplier, currentRound?.originalStake])

  const selectedTeacher = getTeacherById(state.teachers, currentRound?.actualTeacherId ?? mainSelection ?? state.selectedTeacherId)
  const activeSpinExpired = Boolean(state.spin?.phase === 'selection' && !state.pausedWheel && state.spin.deadlineAt <= serverNow)

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand-wrap">
          <div className="brand-icon"><Crown size={18} /></div>
          <div><strong>{state.gameTitle}</strong><small>Event controls</small></div>
        </div>
        <nav>
          <button className={`nav-button ${activeSection === 'dashboard' ? 'active' : ''}`} onClick={() => navTo('dashboard')}>Dashboard</button>
          <button className={`nav-button ${activeSection === 'main-wheel' ? 'active' : ''}`} onClick={() => navTo('main-wheel')}>Main Wheel</button>
          <button className={`nav-button ${activeSection === 'risk-wheel' ? 'active' : ''}`} onClick={() => navTo('risk-wheel')}>Risk Wheel</button>
          <button className={`nav-button ${activeSection === 'settings' ? 'active' : ''}`} onClick={() => navTo('settings')}>Settings</button>
        </nav>
        <div className={`sync-status connection-${connectionStatus}`} role="status">
          {connectionStatus === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{connectionStatus.toUpperCase()} · {latencyMs === null ? 'checking latency' : `${latencyMs} ms`} round-trip</span>
        </div>
        {installPrompt && <button className="secondary-button install-button" onClick={handleInstall}>Install admin app</button>}
        <button className="secondary-button" onClick={onLogout}><Lock size={16} /> Logout</button>
      </aside>

      <main className="admin-main">
        <header className="topbar" id="dashboard">
          <div><h2>Admin dashboard</h2><p>{state.eventName} · operator-controlled roulette</p></div>
          <div className="toolbar-actions">
            <button className="primary-button" onClick={startRound} disabled={!connected || Boolean(isRoundActive)}>New round</button>
            <button className="secondary-button" onClick={() => window.open('/audience', '_blank')}>Open audience</button>
          </div>
        </header>

        <div className="mobile-status" role="status">
          {connectionStatus === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{connectionStatus.toUpperCase()} · {latencyMs === null ? 'checking' : `${latencyMs} ms RTT`}</span>
          {installPrompt && <button onClick={handleInstall}>Install</button>}
        </div>
        {connectionError && <p className="connection-message" role="status">{connectionError}</p>}
        {actionError && <p className="login-error" role="alert">{actionError}</p>}
        {isIos && <p className="ios-install-hint">To install on iPhone/iPad: tap Share in Safari, then “Add to Home Screen”.</p>}

        <section className="mobile-summary" aria-label="Current game summary">
          {[
            ['Current stake', formatStake(currentRound?.originalStake ?? state.currentStake)],
            ['Selected teacher', selectedTeacher?.name ?? 'Not selected'],
            ['Game stage', state.currentStage.replace('-', ' ')],
            ['Main wheel', state.spin?.wheel === 'main' ? state.spin.phase : currentRound?.actualTeacherId ? 'Result locked' : 'Ready'],
            ['Risk wheel', state.spin?.wheel === 'risk' ? state.spin.phase : currentRound?.riskMultiplier !== null && currentRound?.riskMultiplier !== undefined ? `${currentRound.riskMultiplier}X locked` : state.currentStage === 'risk-spin' ? 'Ready' : 'Locked'],
            ['Potential payout', formatStake((currentRound?.originalStake ?? state.currentStake) * Math.max(state.settings.matchMultiplier, 4))],
            ['Final payout', formatStake(currentRound?.status === 'completed' ? currentRound.finalPayout : 0)],
          ].map(([label, value]) => <div className="summary-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          <div className="summary-card"><span>Average / max sync</span><strong>{latencyStats.average} / {latencyStats.maximum} ms</strong></div>
          <div className="summary-card"><span>Commands / failed</span><strong>{state.syncMetrics.commands} / {state.syncMetrics.failedCommands}</strong></div>
          <div className="summary-card"><span>Reconnects / last time</span><strong>{state.syncMetrics.reconnects} / {reconnectTimeMs === null ? '—' : `${reconnectTimeMs} ms`}</strong></div>
        </section>

        <div className="stats-grid">
          {stats.map(({ label, value, icon: Icon }) => (
            <motion.div className="stat-card" key={label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <Icon size={18} /><span>{label}</span><strong>{value}</strong>
            </motion.div>
          ))}
        </div>

        <section className="control-grid" id="round-controls">
          <div className="panel">
            <div className="panel-header"><h3>Event round</h3><BadgeCheck size={16} /></div>
            <div className="field-group">
              <label htmlFor="round-stake">Stake</label>
              <div className="stake-entry">
                <input id="round-stake" type="number" min={state.settings.minimumStake} max={state.settings.maximumStake} value={stakeDraft}
                  disabled={!connected || Boolean(isRoundActive)}
                  onChange={(event) => setStakeEdit({ value: event.target.value, source: state.currentStake })}
                  onBlur={updateStake}
                  onKeyDown={(event) => { if (event.key === 'Enter') updateStake() }} />
                <span>points</span>
              </div>
              <p className="field-hint">Allowed stake: {formatStake(state.settings.minimumStake)}–{formatStake(state.settings.maximumStake)}.</p>
            </div>
            <div className="control-row">
              <button className="primary-button" onClick={startRound} disabled={!connected || Boolean(isRoundActive)}>Start new round</button>
              <button className="secondary-button" onClick={() => runCommand('round.next')} disabled={!connected || Boolean(isRoundActive)}>Start next round</button>
            </div>
            <div className="control-row">
              <button className="secondary-button" onClick={() => runCommand('round.collect')} disabled={!connected || state.currentStage !== 'stage2' || !isRoundActive}>Collect {state.settings.matchMultiplier}X</button>
              <button className="secondary-button" onClick={() => runCommand('round.reset')} disabled={!connected || !isRoundActive}>Cancel round</button>
            </div>
          </div>
          <div className="panel">
            <div className="panel-header"><h3>Round status</h3><Activity size={16} /></div>
            <div className="readout"><strong>Stage:</strong> {state.currentStage.replace('-', ' ')}</div>
            <div className="readout"><strong>Selected teacher:</strong> {selectedTeacher?.name ?? 'Waiting for selection'}</div>
            <div className="readout"><strong>Stake:</strong> {formatStake(currentRound?.originalStake ?? state.currentStake)}</div>
            <div className="readout"><strong>Payout:</strong> {formatStake(currentRound?.finalPayout ?? 0)}</div>
            <p className="field-hint">Wheel results are labelled operator-controlled when selected by the admin, or random when no selection is made.</p>
          </div>
        </section>

        <section className="control-grid wheel-control-grid">
          <div className="panel" id="main-wheel">
            <div className="panel-header"><h3>Main wheel control</h3><Crown size={16} /></div>
            <div className="admin-wheel-container"><WheelDisplay state={state} serverClockOffset={serverClockOffset} compact /></div>
            <CountdownPanel state={state} serverClockOffset={serverClockOffset} />
            <div className="field-group">
              <label>{mainSelection ? 'Change selection' : 'Select winning teacher'} · 15-second window</label>
              <div className="teacher-select-grid">
                {state.teachers.map((teacher) => (
                  <TeacherSelectionButton key={teacher.id} teacher={teacher} selected={mainSelection === teacher.id}
                    disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection' || activeSpinExpired}
                    onClick={() => select(teacher.id)} />
                ))}
              </div>
            </div>
            <div className="touch-controls">
              <button className="primary-button" onClick={() => runCommand('teacher.spin')} disabled={!connected || !isRoundActive || state.currentStage !== 'teacher-spin' || Boolean(state.spin)}><Play size={16} /> START SPIN</button>
              <button className="primary-button" onClick={() => runCommand('teacher.confirm')} disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection' || activeSpinExpired}>CONFIRM SELECTION</button>
              <button className="secondary-button" onClick={() => runCommand(state.pausedWheel === 'main' ? 'wheel.resume' : 'wheel.pause', { wheel: 'main' })}
                disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection'}><Pause size={16} /> {state.pausedWheel === 'main' ? 'RESUME' : 'PAUSE'}</button>
              <button className="secondary-button" onClick={() => runCommand('wheel.reset', { wheel: 'main' })}
                disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection'}><RotateCcw size={16} /> RESET</button>
            </div>
          </div>

          <div className="panel" id="risk-wheel">
            <div className="panel-header"><h3>Risk wheel control</h3><Swords size={16} /></div>
            <div className="admin-wheel-container"><WheelDisplay state={state} serverClockOffset={serverClockOffset} compact /></div>
            <CountdownPanel state={state} serverClockOffset={serverClockOffset} />
            <div className="control-row">
              <button className="secondary-button" onClick={() => runCommand('stage2.start')} disabled={!connected || state.currentStage !== 'stage2' || !isRoundActive}>Begin Stage 2</button>
              <button className="secondary-button" onClick={() => runCommand('round.collect')} disabled={!connected || state.currentStage !== 'stage2' || !isRoundActive}>Collect {state.settings.matchMultiplier}X</button>
            </div>
            <div className="field-group">
              <label>{riskSelection ? 'Change multiplier' : 'Select multiplier'} · 15-second window</label>
              <div className="risk-choice-grid">
                {([0, 3, 4] as const).map((multiplier) => (
                  <button className={`risk-choice ${riskSelection === String(multiplier) ? 'selected' : ''}`} key={multiplier}
                    disabled={!connected || state.spin?.wheel !== 'risk' || state.spin.phase !== 'selection' || activeSpinExpired}
                    onClick={() => select(multiplier)}>SELECT {multiplier}X</button>
                ))}
              </div>
            </div>
            <div className="touch-controls">
              <button className="primary-button" onClick={() => runCommand('risk.spin')} disabled={!connected || !isRoundActive || state.currentStage !== 'risk-spin' || Boolean(state.spin) || currentRound?.riskMultiplier !== null}><Play size={16} /> START RISK SPIN</button>
              <button className="primary-button" onClick={() => runCommand('risk.confirm')}
                disabled={!connected || state.spin?.wheel !== 'risk' || state.spin.phase !== 'selection' || activeSpinExpired}>CONFIRM SELECTION</button>
              <button className="secondary-button" onClick={() => runCommand(state.pausedWheel === 'risk' ? 'wheel.resume' : 'wheel.pause', { wheel: 'risk' })}
                disabled={!connected || state.spin?.wheel !== 'risk' || state.spin.phase !== 'selection'}><Pause size={16} /> {state.pausedWheel === 'risk' ? 'RESUME' : 'PAUSE'}</button>
              <button className="secondary-button" onClick={() => runCommand('wheel.reset', { wheel: 'risk' })}
                disabled={!connected || state.spin?.wheel !== 'risk' || state.spin.phase !== 'selection'}><RotateCcw size={16} /> RESET</button>
              <button className="primary-button" onClick={() => runCommand('risk.confirm')}
                disabled={!connected || Boolean(state.spin) || state.currentStage !== 'risk-spin' || currentRound?.riskMultiplier === null}>CONFIRM PAYOUT</button>
            </div>
            <div className="field-group">
              <label>Locked multiplier</label>
              <div className="readout">{currentRound?.riskMultiplier === null || currentRound?.riskMultiplier === undefined ? '—' : `${currentRound.riskMultiplier}X · ${currentRound.riskResultMode ?? 'pending'}`}</div>
            </div>
          </div>
        </section>

        <section className="bottom-grid">
          <div className="panel">
            <div className="panel-header"><h3>Teachers</h3><Sparkles size={16} /></div>
            <div className="teacher-list">
              {state.teachers.map((teacher) => (
                <div className="teacher-item" key={teacher.id}>
                  <div className="swatch" style={{ background: teacher.color }} />
                  <div><strong>{teacher.name}</strong><small>{teacher.personality}</small></div>
                </div>
              ))}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header"><h3>Outcome audit</h3><Shield size={16} /></div>
            {state.auditLog.length
              ? <ol className="audit-log">{state.auditLog.slice(0, 12).map((entry) => (
                  <li key={entry.actionId}><strong>{entry.action === 'teacher.spin' ? 'Main wheel' : 'Risk wheel'}: {entry.outcome}</strong><span>{entry.actor} · {new Date(entry.at).toLocaleString()}</span></li>
                ))}</ol>
              : <p className="field-hint">No operator-selected outcomes yet.</p>}
          </div>
        </section>

        <section className="panel full-panel">
          <div className="panel-header"><h3>Round history</h3><Activity size={16} /></div>
          <table>
            <thead><tr><th>Round</th><th>Teacher</th><th>Stake</th><th>Payout</th><th>Main result</th><th>Risk result</th><th>Status</th></tr></thead>
            <tbody>{state.history.slice(0, 12).map((entry) => (
              <tr key={entry.id}>
                <td>{entry.id}</td>
                <td>{getTeacherById(state.teachers, entry.actualTeacherId)?.name ?? '—'}</td>
                <td>{formatStake(entry.originalStake)}</td>
                <td>{formatStake(entry.finalPayout)}</td>
                <td>{entry.mainResultMode ?? '—'}</td>
                <td>{entry.riskMultiplier === null ? '—' : `${entry.riskMultiplier}X · ${entry.riskResultMode ?? '—'}`}</td>
                <td>{entry.status}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>

        <section className="panel settings-panel" id="settings">
          <div className="panel-header"><h3>Game settings</h3><Shield size={16} /></div>
          <div className="settings-grid">
            <label>Game title<input value={state.gameTitle} onChange={(event) => runCommand('admin.state.update', { state: { ...state, gameTitle: event.target.value }})} /></label>
            <label>Event name<input value={state.eventName} onChange={(event) => runCommand('admin.state.update', { state: { ...state, eventName: event.target.value }})} /></label>
            <label>Match payout multiplier<input type="number" value={state.settings.matchMultiplier} onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value > 0) runCommand('admin.state.update', { state: { ...state, settings: { ...state.settings, matchMultiplier: value } } })
            }} /></label>
          </div>
        </section>

        <nav className="mobile-bottom-nav" aria-label="Admin navigation">
          <button onClick={() => navTo('dashboard')}>Home</button>
          <button onClick={() => navTo('round-controls')}>Round</button>
          <button onClick={() => navTo('main-wheel')}>Main</button>
          <button onClick={() => navTo('risk-wheel')}>Risk</button>
        </nav>
      </main>
    </div>
  )
}

function TeacherSelectionButton({ teacher, selected, disabled, onClick }: {
  teacher: Teacher
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button className={`teacher-select ${selected ? 'selected' : ''}`} disabled={disabled} onClick={onClick}>
      <span style={{ backgroundColor: teacher.color }} />{teacher.name}
    </button>
  )
}

function AudienceScreen({ state, connectionStatus, serverClockOffset }: {
  state: GameState
  connectionStatus: ConnectionStatus
  serverClockOffset: number
}) {
  const selectedId = state.spin?.wheel === 'main' ? state.spin.selectedId : state.currentRound?.actualTeacherId
  const selectedTeacher = getTeacherById(state.teachers, selectedId ?? null)
  const riskSpin = state.spin?.wheel === 'risk' ? state.spin : null

  return (
    <div className="audience-shell">
      <header className="audience-header">
        <div><div className="eyebrow">{state.eventName} · Operator-controlled event roulette</div><h1>{state.gameTitle}</h1></div>
        <div className={`audience-status connection-${connectionStatus}`}>
          <span>{connectionStatus.toUpperCase()}</span><small>{state.currentStage.toUpperCase()}</small>
        </div>
      </header>

      <div className="audience-layout">
        <div className="wheel-panel"><WheelDisplay state={state} serverClockOffset={serverClockOffset} /></div>
        <aside className="audience-side">
          <CountdownPanel state={state} serverClockOffset={serverClockOffset} />
          <div className="glass-card">
            <div className="card-row"><span>Selected teacher</span><strong>{selectedTeacher?.name ?? '—'}</strong></div>
            <div className="card-row"><span>Stake</span><strong>{formatStake(state.currentRound?.originalStake ?? state.currentStake)}</strong></div>
            <div className="card-row"><span>Current stage</span><strong>{state.currentStage.replace('-', ' ')}</strong></div>
            {riskSpin?.selectedId && <div className="card-row"><span>{riskSpin.phase === 'decelerating' && riskSpin.resultMode === 'random' ? 'Random result' : 'Operator selection'}</span><strong>{riskSpin.selectedId}X · {riskSpin.resultMode === 'random' ? 'random' : 'operator-controlled'}</strong></div>}
            {state.currentRound?.mainResultMode && <div className="card-row"><span>Main result mode</span><strong>{state.currentRound.mainResultMode}</strong></div>}
            {state.currentRound?.riskResultMode && <div className="card-row"><span>Risk result mode</span><strong>{state.currentRound.riskResultMode}</strong></div>}
            <div className="card-row"><span>Final payout</span><strong>{formatStake(state.currentRound?.status === 'completed' ? state.currentRound.finalPayout : 0)}</strong></div>
          </div>
          <motion.div className="glass-card wide-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <h3>{state.audienceMessage}</h3>
              <p className="audience-prompt">Results are operator-controlled when the admin selects an outcome; otherwise, the result is random.</p>
          </motion.div>
        </aside>
      </div>
    </div>
  )
}

export default App
