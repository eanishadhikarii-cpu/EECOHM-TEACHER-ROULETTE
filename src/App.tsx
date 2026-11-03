import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
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
    let effectActive = true
    queueMicrotask(() => {
      if (effectActive) client.connect()
    })
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
    return () => {
      effectActive = false
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
        <Route
          path="/risk"
          element={isAdminLoggedIn
            ? <RiskRoulettePage
                state={state}
                sendCommand={sendCommand}
                connectionStatus={connectionStatus}
                serverClockOffset={serverClockOffset}
              />
            : <AudienceScreen state={state} connectionStatus={connectionStatus} serverClockOffset={serverClockOffset} riskOnly />}
        />
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
          Username
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

function WheelDisplay({ state, serverClockOffset, compact = false, wheel = 'main' }: {
  state: GameState
  serverClockOffset: number
  compact?: boolean
  wheel?: 'main' | 'risk'
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
  const wheelStyle = (targetWheel: 'main' | 'risk'): CSSProperties => {
    const wheelSpin = spin?.wheel === targetWheel ? spin : null
    const preview = wheelSpin?.phase === 'selection'
    const stopping = wheelSpin?.phase === 'decelerating'
    const rotation = targetWheel === 'main' ? state.outerWheelRotation : state.innerWheelRotation
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
      animationPlayState: state.pausedWheel === targetWheel ? 'paused' : 'running',
    } as CSSProperties
  }

  return (
    <div className={`wheel-wrap ${compact ? 'admin-wheel-wrap' : ''}`}>
      <div className="wheel-pointer" />
      {wheel === 'main'
        ? <div
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
        : <div
            key={`inner-${state.innerSpinSequence}`}
            className="wheel risk-wheel-display"
            style={{
              ...wheelStyle('risk'),
              background: `conic-gradient(${riskColors[0]} 0deg 120deg, ${riskColors[1]} 120deg 240deg, ${riskColors[2]} 240deg 360deg)`,
            }}
          >
            {([0, 3, 4] as const).map((multiplier, index) => {
              const angle = index * 120 + 60
              return <div key={multiplier} className="inner-label" style={{ transform: `rotate(${angle}deg) translateY(-39%) rotate(${-angle}deg)` }}>{multiplier}X</div>
            })}
          </div>}
      <div className="center-spin" aria-hidden="true">
        {spin?.phase === 'selection' && spin.wheel === wheel && countdown !== null ? countdown : spin?.phase === 'decelerating' && spin.wheel === wheel ? 'LOCK' : ''}
      </div>
    </div>
  )
}

function CountdownPanel({ state, serverClockOffset }: { state: GameState; serverClockOffset: number }) {
  const serverNow = useServerNow(state, serverClockOffset)
  const spin = state.spin
  if (!spin) return <div className="countdown-panel"><span>NO ACTIVE SPIN</span><strong>READY</strong></div>
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
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState('dashboard')
  const [actionError, setActionError] = useState('')
  const [betDrafts, setBetDrafts] = useState<Record<string, string>>({})
  const currentRound = state.currentRound
  const totalConfiguredBets = Object.values(state.teacherBets).reduce((total, amount) => total + amount, 0)
  const isRoundActive = currentRound?.status === 'in-progress'
  const connected = connectionStatus === 'connected'
  const serverNow = useServerNow(state, serverClockOffset)
  const mainSelection = state.spin?.wheel === 'main' ? state.spin.selectedId : null
  const eligibleStake = currentRound?.actualTeacherId
    ? currentRound.teacherBets[currentRound.actualTeacherId] ?? 0
    : 0

  const runCommand = (action: string, payload: Record<string, unknown> = {}, message = 'Action failed.') => {
    void sendCommand(action, payload)
      .then(() => setActionError(''))
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : message))
  }

  const updateTeacherBet = (teacherId: string) => {
    const amount = Number(betDrafts[teacherId])
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > state.settings.maximumStake) {
      setActionError(`Each teacher's bet total must be a whole number from 0 to ${state.settings.maximumStake}.`)
      return
    }
    void sendCommand('admin.bets.update', { teacherId, amount })
      .then(() => {
        setActionError('')
        setBetDrafts((current) => {
          if (current[teacherId] !== String(amount)) return current
          const next = { ...current }
          delete next[teacherId]
          return next
        })
      })
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Could not update teacher bets.'))
  }

  const startRound = () => runCommand('round.start')
  const select = (selection: string | number) => runCommand('spin.select', { selection: String(selection) }, 'Could not update selection.')
  const chooseRisk = async () => {
    try {
      await sendCommand('stage2.start')
      navigate('/risk')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not open the risk stage.')
    }
  }
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
    { label: 'Total bets', value: formatStake(currentRound?.originalStake ?? state.currentStake), icon: CircleDollarSign },
    { label: 'Eligible winning bets', value: formatStake(eligibleStake), icon: BadgeCheck },
    { label: 'Manual results', value: String(state.auditLog.length), icon: Shield },
  ], [state.history.length, state.auditLog.length, state.currentStake, currentRound?.originalStake, eligibleStake])

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
          <button className={`nav-button ${activeSection === 'risk-wheel' ? 'active' : ''}`} onClick={() => navigate('/risk')}>Risk Roulette</button>
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
            <button className="primary-button" onClick={startRound} disabled={!connected || Boolean(isRoundActive) || totalConfiguredBets <= 0}>New round</button>
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
            ['Total bets', formatStake(currentRound?.originalStake ?? state.currentStake)],
            ['Selected teacher', selectedTeacher?.name ?? 'Not selected'],
            ['Eligible bets', formatStake(eligibleStake)],
            ['Game stage', state.currentStage.replace('-', ' ')],
            ['Main wheel', state.spin?.wheel === 'main' ? state.spin.phase : currentRound?.actualTeacherId ? 'Result locked' : 'Ready'],
            ['Risk wheel', state.spin?.wheel === 'risk' ? state.spin.phase : currentRound?.riskMultiplier !== null && currentRound?.riskMultiplier !== undefined ? `${currentRound.riskMultiplier}X locked` : state.currentStage === 'risk-spin' ? 'Ready' : 'Locked'],
            ['Potential payout', formatStake(eligibleStake * Math.max(state.settings.matchMultiplier, 4))],
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
            <div className="panel-header"><h3>Round management &amp; teacher bets</h3><BadgeCheck size={16} /></div>
            <p className="field-hint">Enter anonymous total bets per teacher. The team records one collect-or-risk decision for all bets on the winning teacher. Max {formatStake(state.settings.maximumStake)} per teacher.</p>
            <div className="bet-entry-grid">
              {state.teachers.map((teacher) => (
                <label className="bet-entry-row" key={teacher.id}>
                  <span>{teacher.name}</span>
                  <input
                    aria-label={`${teacher.name} total bets`}
                    type="number"
                    min={0}
                    max={state.settings.maximumStake}
                    step={1}
                    value={betDrafts[teacher.id] ?? String(state.teacherBets[teacher.id] ?? 0)}
                    disabled={!connected || state.currentStage !== 'waiting' || Boolean(isRoundActive)}
                    onChange={(event) => setBetDrafts((current) => ({ ...current, [teacher.id]: event.target.value }))}
                    onBlur={() => updateTeacherBet(teacher.id)}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                  />
                  <strong>{formatStake(state.teacherBets[teacher.id] ?? 0)}</strong>
                </label>
              ))}
            </div>
            <div className="readout"><strong>Total bets entered:</strong> {formatStake(currentRound?.originalStake ?? state.currentStake)}</div>
            <div className="control-row">
              <button className="primary-button" onClick={startRound} disabled={!connected || Boolean(isRoundActive) || totalConfiguredBets <= 0}>Start new round</button>
              <button className="secondary-button" onClick={() => runCommand('round.next')} disabled={!connected || Boolean(isRoundActive) || state.currentStage !== 'waiting'}>Clear bets</button>
            </div>
            <div className="control-row">
              <button className="secondary-button" onClick={() => runCommand('round.reset')} disabled={!connected || !isRoundActive}>Cancel round</button>
              {state.currentStage === 'risk-spin' && <button className="primary-button" onClick={() => navigate('/risk')}>Open Risk Roulette</button>}
            </div>
          </div>
          <div className="panel">
            <div className="panel-header"><h3>Round status</h3><Activity size={16} /></div>
            <div className="readout"><strong>Stage:</strong> {state.currentStage.replace('-', ' ')}</div>
            <div className="readout"><strong>Selected teacher:</strong> {selectedTeacher?.name ?? 'Waiting for selection'}</div>
            <div className="readout"><strong>Eligible winning bets:</strong> {formatStake(eligibleStake)}</div>
            <div className="readout"><strong>Payout:</strong> {formatStake(currentRound?.finalPayout ?? 0)}</div>
            <p className="field-hint">Wheel results are labelled operator-controlled when selected by the admin, or random when no selection is made.</p>
          </div>
        </section>

        <section className="control-grid wheel-control-grid">
          <div className="panel" id="main-wheel">
            <div className="panel-header"><h3>Main wheel control</h3><Crown size={16} /></div>
            <div className="admin-wheel-container"><WheelDisplay state={state} serverClockOffset={serverClockOffset} compact /></div>
            <div className="touch-controls main-wheel-controls">
              <button className="primary-button" onClick={() => runCommand('teacher.spin')} disabled={!connected || !isRoundActive || state.currentStage !== 'teacher-spin' || Boolean(state.spin)}><Play size={16} /> START SPIN</button>
            </div>
            <CountdownPanel state={state} serverClockOffset={serverClockOffset} />
            <div className="field-group">
              <label>{mainSelection ? 'Change selection' : 'Select winning teacher'} · during the 10-second spin</label>
              <div className="teacher-select-grid">
                {state.teachers.map((teacher) => (
                  <TeacherSelectionButton key={teacher.id} teacher={teacher} selected={mainSelection === teacher.id}
                    betTotal={currentRound?.teacherBets[teacher.id] ?? state.teacherBets[teacher.id] ?? 0}
                    disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection' || activeSpinExpired}
                    onClick={() => select(teacher.id)} />
                ))}
              </div>
            </div>
            <div className="touch-controls">
              <button className="primary-button" onClick={() => runCommand('teacher.confirm')} disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection' || activeSpinExpired}>CONFIRM SELECTION</button>
              <button className="secondary-button" onClick={() => runCommand(state.pausedWheel === 'main' ? 'wheel.resume' : 'wheel.pause', { wheel: 'main' })}
                disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection'}><Pause size={16} /> {state.pausedWheel === 'main' ? 'RESUME' : 'PAUSE'}</button>
              <button className="secondary-button" onClick={() => runCommand('wheel.reset', { wheel: 'main' })}
                disabled={!connected || state.spin?.wheel !== 'main' || state.spin.phase !== 'selection'}><RotateCcw size={16} /> RESET</button>
            </div>
          </div>

        </section>

        {state.currentStage === 'stage2' && isRoundActive && (
          <section className="panel decision-panel" aria-labelledby="risk-decision">
            <div className="panel-header"><h3 id="risk-decision">DO YOU WANT TO TAKE A RISK?</h3><Swords size={18} /></div>
            <p>Your teacher result is locked. Choose to collect the match payout or open the separate risk wheel.</p>
            <div className="decision-actions">
              <button className="primary-button" onClick={chooseRisk} disabled={!connected}>YES — TAKE THE RISK</button>
              <button className="secondary-button" onClick={() => runCommand('round.collect')} disabled={!connected}>NO — COLLECT {state.settings.matchMultiplier}X</button>
            </div>
          </section>
        )}
        {state.currentStage === 'no-winners' && isRoundActive && (
          <section className="panel decision-panel" aria-labelledby="no-winners-title">
            <div className="panel-header"><h3 id="no-winners-title">NO WINNING BETS</h3><BadgeCheck size={18} /></div>
            <p>{selectedTeacher?.name ?? 'The selected teacher'} has no eligible bets. Confirm to close this round with a 0-point payout.</p>
            <button className="primary-button" onClick={() => runCommand('round.no-winners.confirm')} disabled={!connected}>CONFIRM — NO PAYOUT</button>
          </section>
        )}

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
          <button onClick={() => navigate('/risk')}>Risk</button>
        </nav>
      </main>
    </div>
  )
}

function RiskRoulettePage({
  state,
  sendCommand,
  connectionStatus,
  serverClockOffset,
}: {
  state: GameState
  sendCommand: (action: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>
  connectionStatus: ConnectionStatus
  serverClockOffset: number
}) {
  const navigate = useNavigate()
  const [actionError, setActionError] = useState('')
  const connected = connectionStatus === 'connected'
  const round = state.currentRound
  const spin = state.spin
  const serverNow = useServerNow(state, serverClockOffset)
  const selectionExpired = Boolean(spin?.phase === 'selection' && !state.pausedWheel && spin.deadlineAt <= serverNow)
  const selectedMultiplier = spin?.wheel === 'risk' ? spin.selectedId : null
  const lockedMultiplier = round?.riskMultiplier
  const isRoundActive = round?.status === 'in-progress'
  const eligibleStake = round?.actualTeacherId ? round.teacherBets[round.actualTeacherId] ?? 0 : 0

  const runCommand = (action: string, payload: Record<string, unknown> = {}) => {
    void sendCommand(action, payload)
      .then(() => setActionError(''))
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Action failed.'))
  }
  const confirmPayout = async () => {
    try {
      await sendCommand('risk.confirm')
      setActionError('')
      navigate('/admin')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Payout could not be confirmed.')
    }
  }

  return (
    <div className="risk-page">
      <header className="risk-page-header">
        <div>
          <div className="eyebrow">PRIVATE ADMIN CONTROLS</div>
          <h1>RISK ROULETTE</h1>
          <p>Separate second stage · Eligible winning bets {formatStake(eligibleStake)}</p>
        </div>
        <div className={`sync-status connection-${connectionStatus}`} role="status">
          {connectionStatus === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{connectionStatus.toUpperCase()}</span>
          <button className="secondary-button" onClick={() => navigate('/admin')}>Main game</button>
        </div>
      </header>
      {actionError && <p className="login-error" role="alert">{actionError}</p>}
      <main className="risk-page-content">
        <div className="panel risk-wheel-panel">
          <div className="panel-header"><h2>Choose the risk outcome</h2><Swords size={20} /></div>
          <div className="admin-wheel-container"><WheelDisplay state={state} serverClockOffset={serverClockOffset} wheel="risk" /></div>
          <div className="touch-controls risk-touch-controls">
            <button className="primary-button" onClick={() => runCommand('risk.spin')}
              disabled={!connected || !isRoundActive || state.currentStage !== 'risk-spin' || Boolean(spin) || lockedMultiplier !== null}>
              <Play size={16} /> START RISK SPIN
            </button>
          </div>
          <CountdownPanel state={state} serverClockOffset={serverClockOffset} />
          <div className="risk-choice-grid">
            {([0, 3, 4] as const).map((multiplier) => (
              <button
                className={`risk-choice ${selectedMultiplier === String(multiplier) ? 'selected' : ''}`}
                key={multiplier}
                disabled={!connected || spin?.wheel !== 'risk' || spin.phase !== 'selection' || selectionExpired}
                onClick={() => runCommand('spin.select', { selection: String(multiplier) })}
              >
                {multiplier}X
              </button>
            ))}
          </div>
          <div className="touch-controls risk-touch-controls">
            <button className="primary-button" onClick={() => runCommand('risk.confirm')}
              disabled={!connected || spin?.wheel !== 'risk' || spin.phase !== 'selection' || selectionExpired}>
              CONFIRM SELECTION
            </button>
            <button className="secondary-button" onClick={() => runCommand(state.pausedWheel === 'risk' ? 'wheel.resume' : 'wheel.pause', { wheel: 'risk' })}
              disabled={!connected || spin?.wheel !== 'risk' || spin.phase !== 'selection'}>
              <Pause size={16} /> {state.pausedWheel === 'risk' ? 'RESUME' : 'PAUSE'}
            </button>
            <button className="secondary-button" onClick={() => runCommand('wheel.reset', { wheel: 'risk' })}
              disabled={!connected || spin?.wheel !== 'risk' || spin.phase !== 'selection'}>
              <RotateCcw size={16} /> RESET
            </button>
            <button className="primary-button" onClick={() => void confirmPayout()}
              disabled={!connected || !isRoundActive || Boolean(spin) || lockedMultiplier === null || lockedMultiplier === undefined}>
              CONFIRM PAYOUT
            </button>
          </div>
          <div className="risk-result-readout">
            <span>Locked result</span>
            <strong>{lockedMultiplier === null || lockedMultiplier === undefined ? 'Waiting for spin' : `${lockedMultiplier}X · ${round?.riskResultMode ?? 'pending'}`}</strong>
            <span>Potential final payout</span>
            <strong>{formatStake(eligibleStake * (lockedMultiplier ?? 0))}</strong>
          </div>
        </div>
      </main>
    </div>
  )
}

function TeacherSelectionButton({ teacher, selected, betTotal, disabled, onClick }: {
  teacher: Teacher
  selected: boolean
  betTotal: number
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button className={`teacher-select ${selected ? 'selected' : ''}`} disabled={disabled} onClick={onClick}>
      <span className="teacher-select-swatch" style={{ backgroundColor: teacher.color }} />
      <span className="teacher-select-name">{teacher.name}</span>
      <small>{formatStake(betTotal)}</small>
    </button>
  )
}

function AudienceScreen({ state, connectionStatus, serverClockOffset, riskOnly = false }: {
  state: GameState
  connectionStatus: ConnectionStatus
  serverClockOffset: number
  riskOnly?: boolean
}) {
  const navigate = useNavigate()
  const audienceServerNow = useServerNow(state, serverClockOffset)
  const selectedId = state.spin?.wheel === 'main' ? state.spin.selectedId : state.currentRound?.actualTeacherId
  const selectedTeacher = getTeacherById(state.teachers, selectedId ?? null)
  const showingRisk = riskOnly || state.currentStage === 'risk-spin'
  const activeSpin = state.spin?.wheel === (showingRisk ? 'risk' : 'main') ? state.spin : null
  const announcement = state.currentStage === 'stage2'
    ? 'DO YOU WANT TO TAKE A RISK?'
    : state.currentRound?.status === 'completed'
      ? state.audienceMessage
      : state.currentStage === 'no-winners'
        ? state.audienceMessage
        : showingRisk
        ? state.currentRound?.riskMultiplier !== null && state.currentRound?.riskMultiplier !== undefined
          ? `Risk result: ${state.currentRound.riskMultiplier}X`
          : ''
        : state.currentRound?.actualTeacherId
          ? `Selected teacher: ${selectedTeacher?.name ?? '—'}`
          : state.currentStage === 'waiting'
            ? state.audienceMessage
            : ''
  const resultMode = showingRisk ? state.currentRound?.riskResultMode : state.currentRound?.mainResultMode

  useEffect(() => {
    if (connectionStatus !== 'connected') return
    if (riskOnly && state.currentStage !== 'risk-spin') navigate('/audience', { replace: true })
    else if (!riskOnly && state.currentStage === 'risk-spin') navigate('/risk', { replace: true })
  }, [connectionStatus, navigate, riskOnly, state.currentStage])

  return (
    <div className="audience-shell">
      <header className="audience-header">
        <div><div className="eyebrow">{state.eventName} · Operator-controlled event roulette</div><h1>{showingRisk ? 'RISK ROULETTE' : state.gameTitle}</h1></div>
        <div className={`audience-status connection-${connectionStatus}`}>
          <span>{connectionStatus.toUpperCase()}</span><small>{state.currentStage.toUpperCase()}</small>
        </div>
      </header>

      <div className="audience-layout">
        <div className="audience-announcement" aria-live="polite">
          {announcement && <h2>{announcement}</h2>}
          {activeSpin?.phase === 'selection' && <p>{getCountdown(activeSpin, audienceServerNow)} seconds · select outcome on the admin panel</p>}
          {activeSpin?.phase === 'decelerating' && <p>Result locked · slowing to a stop</p>}
          {resultMode && <p>{resultMode === 'random' ? 'Random result' : 'Operator-controlled result'}</p>}
          {state.currentRound?.status === 'completed' && <p>Final payout: {formatStake(state.currentRound.finalPayout)} · returning to the main game shortly</p>}
        </div>
        <div className="wheel-panel audience-wheel-panel">
          <WheelDisplay state={state} serverClockOffset={serverClockOffset} wheel={showingRisk ? 'risk' : 'main'} />
          <button className="audience-spin-button" type="button" disabled aria-live="polite">
            {activeSpin ? 'SPINNING…' : 'SPIN'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
