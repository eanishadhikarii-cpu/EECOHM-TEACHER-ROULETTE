import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomInt, timingSafeEqual, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url))
const production = process.argv.includes('--production')
const port = Number(process.env.PORT ?? 5173)

function loadEnvironment() {
  for (const filename of ['.env', '.env.local']) {
    const path = join(root, filename)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
      }
    }
  }
}

loadEnvironment()

const adminEmail = process.env.ADMIN_EMAIL ?? ''
const adminPassword = process.env.ADMIN_PASSWORD ?? ''
const statePath = process.env.GAME_STATE_PATH ? resolve(process.env.GAME_STATE_PATH) : join(root, 'data', 'game-state.json')
const sessions = new Map()
const processedActions = new Map()
const clients = new Set()
let vite

const colors = ['#ff6b6b', '#ffd93d', '#6c5ce7', '#00d2d3', '#ff9f1c', '#ef476f', '#1dd1a1', '#a29bfe', '#feca57', '#48dbfb', '#ff9ff3', '#c56cf0']
const seedTeachers = [
  ['Mr. Sharma', 'Angry Professor'], ['Mrs. Rai', 'Strict Examiner'], ['Mr. Khan', 'Sleeping Teacher'],
  ['Mrs. Thapa', 'Homework Queen'], ['Mr. Joshi', 'Attendance Police'], ['Mrs. Gurung', 'Dancing Teacher'],
  ['Mr. Das', 'Calculator Master'], ['Mrs. Lama', 'Surprise Test Queen'], ['Mr. Adhikari', 'Late Entry King'],
  ['Mrs. Singh', 'Grammar Police'], ['Mr. Pandey', 'Mobile Confiscator'], ['Mrs. Karki', "Principal's Favourite"],
]

function createInitialState() {
  return {
    gameTitle: 'TEACHER ROULETTE',
    eventName: 'College Gala Night',
    teachers: seedTeachers.map(([name, personality], index) => ({
      id: `teacher-${index + 1}`, name, personality, imageUrl: '', color: colors[index],
      isActive: true, position: index + 1,
    })),
    settings: {
      gameTitle: 'TEACHER ROULETTE', eventName: 'College Gala Night', defaultStake: 100,
      minimumStake: 20, maximumStake: 500, soundEnabled: true, confettiEnabled: true,
      matchMultiplier: 2, riskMultipliers: [0, 3, 4],
    },
    currentStage: 'waiting',
    selectedTeacherId: null,
    currentStake: 100,
    selectedTeacherRoll: null,
    currentRound: null,
    history: [],
    auditLog: [],
    audienceMessage: 'Ready for the next event round.',
    lastAction: 'System ready',
    outerWheelRotation: 0,
    innerWheelRotation: 0,
    outerWheelStartRotation: 0,
    innerWheelStartRotation: 0,
    outerSpinSequence: 0,
    innerSpinSequence: 0,
    locked: false,
    pausedWheel: null,
    revision: 0,
    serverTime: Date.now(),
    syncMetrics: { commands: 0, failedCommands: 0, averageLatencyMs: 0, maxLatencyMs: 0, averageReconnectMs: 0, maxReconnectMs: 0, reconnects: 0 },
  }
}

function readState() {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    const defaults = createInitialState()
    const restored = {
      ...defaults,
      ...saved,
      settings: { ...defaults.settings, ...saved.settings },
      revision: Number(saved.revision) || 0,
    }
    delete restored.players
    delete restored.currentPlayerId
    delete restored.recentWinners
    delete restored.settings.leaderboardEnabled
    delete restored.settings.recentWinnersEnabled
    delete restored.settings.manualDemoMode
    delete restored.settings.randomOutcomeMode
    delete restored.settings.wheelSpinDuration
    delete restored.settings.animationSpeed
    restored.history = Array.isArray(restored.history) ? restored.history.map(stripPlayerFields) : []
    restored.currentRound = restored.currentRound ? stripPlayerFields(restored.currentRound) : null
    if (restored.currentStage === 'bet') restored.currentStage = restored.currentRound ? 'teacher-spin' : 'waiting'
    if (restored.spin && (!restored.spin.phase || !restored.spin.deadlineAt)) restored.spin = null
    return restored
  } catch {
    return createInitialState()
  }
}

function stripPlayerFields(round) {
  const { playerId, playerName, selectedTeacherId, resultMode, ...cleanRound } = round
  void playerId
  void playerName
  void selectedTeacherId
  void resultMode
  return {
    ...cleanRound,
    stageOneResult: cleanRound.actualTeacherId ? 'selected' : 'pending',
    mainResultMode: cleanRound.mainResultMode ?? (cleanRound.actualTeacherId ? resultMode === 'manual' ? 'operator-controlled' : 'random' : null),
    riskResultMode: cleanRound.riskResultMode ?? (cleanRound.riskMultiplier !== null ? resultMode === 'manual' ? 'operator-controlled' : 'random' : null),
  }
}

let state = readState()

function persistState() {
  try {
    const { mkdirSync, writeFileSync } = awaitImportFs
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('Unable to persist game state:', error)
  }
}

import * as awaitImportFs from 'node:fs'

persistState()

function publicState() {
  return { ...state, serverTime: Date.now() }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function broadcast(payload) {
  const message = JSON.stringify(payload)
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message)
  }
}

function broadcastState(event = 'state') {
  state.serverTime = Date.now()
  persistState()
  broadcast({ type: event, state: publicState(), serverTime: Date.now() })
}

function findTeacher(id, activeOnly = false) {
  return state.teachers.find((teacher) => teacher.id === id && (!activeOnly || teacher.isActive))
}

function randomTeacher() {
  if (!state.teachers.length) throw new Error('No teachers are available.')
  return state.teachers[randomInt(state.teachers.length)]
}

function randomRisk() {
  return [0, 3, 4][randomInt(3)]
}

function targetRotation(index, total, currentRotation) {
  const segment = 360 / total
  const stop = (360 - (index * segment + segment / 2) % 360) % 360
  const current = ((currentRotation % 360) + 360) % 360
  const delta = (stop - current + 360) % 360
  return currentRotation + 360 * 5 + delta
}

function finishRound(round) {
  round.status = 'completed'
  state.history.unshift({ ...round, completedAt: new Date().toISOString() })
  state.currentStage = 'final'
}

function startWheelSelection(wheel, actionId) {
  const now = Date.now()
  const startedAt = now + 250
  const fromRotation = wheel === 'main' ? state.outerWheelRotation : state.innerWheelRotation
  state.spin = {
    wheel,
    phase: 'selection',
    actionId,
    startedAt,
    durationMs: 15000,
    deadlineAt: startedAt + 15000,
    selectedId: null,
    selectionActionId: null,
    resultId: null,
    resultMode: null,
    fromRotation,
    toRotation: null,
  }
  state.pausedWheel = null
  if (wheel === 'main') state.outerSpinSequence += 1
  else state.innerSpinSequence += 1
  state.audienceMessage = `${wheel === 'main' ? 'Main' : 'Risk'} wheel selection is open for 15 seconds.`
  state.lastAction = `${wheel === 'main' ? 'Main' : 'Risk'} wheel started`
}

const spinTimers = new Map()

function clearSpinTimer(key) {
  const timer = spinTimers.get(key)
  if (timer) clearTimeout(timer)
  spinTimers.delete(key)
}

function updateTimedState() {
  state.revision += 1
  state.serverTime = Date.now()
  broadcastState('state')
}

function selectedRotation(wheel, selection, startRotation) {
  if (wheel === 'main') {
    const index = state.teachers.findIndex((teacher) => teacher.id === selection)
    if (index < 0) throw new Error('The selected teacher is no longer active.')
    return targetRotation(index, state.teachers.length, startRotation)
  }
  const index = [0, 3, 4].indexOf(Number(selection))
  if (index < 0) throw new Error('Risk outcome must be 0X, 3X, or 4X.')
  return targetRotation(index, 3, startRotation)
}

function completeSpin(wheel) {
  const spin = state.spin
  const round = state.currentRound
  if (!spin || spin.wheel !== wheel || spin.phase !== 'decelerating' || !round || round.status !== 'in-progress') return false
  clearSpinTimer(`${wheel}:complete`)
  if (wheel === 'main') {
    const teacher = findTeacher(spin.resultId)
    if (!teacher || !spin.resultMode) return false
    state.currentRound = {
      ...round,
      actualTeacherId: teacher.id,
      stageOneResult: 'selected',
      mainResultMode: spin.resultMode,
      finalPayout: round.originalStake * state.settings.matchMultiplier,
    }
    state.selectedTeacherRoll = teacher.id
    state.currentStage = 'stage2'
    state.audienceMessage = `Selected teacher: ${teacher.name}. ${spin.resultMode === 'operator-controlled' ? 'Operator-controlled result.' : 'Random result.'}`
    state.lastAction = 'Main wheel result locked'
  } else {
    const multiplier = Number(spin.resultId)
    if (![0, 3, 4].includes(multiplier) || !spin.resultMode) return false
    state.currentRound = { ...round, riskMultiplier: multiplier, riskResultMode: spin.resultMode }
    state.audienceMessage = `Risk wheel result: ${multiplier}X. ${spin.resultMode === 'operator-controlled' ? 'Operator-controlled result.' : 'Random result.'}`
    state.lastAction = 'Risk wheel result locked'
  }
  state.spin = null
  state.pausedWheel = null
  return true
}

function lockSpin(wheel, allowDeadline = false) {
  const spin = state.spin
  if (!spin || spin.wheel !== wheel || spin.phase !== 'selection' || spin.pausedAt) return false
  const now = Date.now()
  if (!allowDeadline && now >= spin.deadlineAt) return false
  const selection = spin.selectedId ?? (wheel === 'main' ? randomTeacher().id : String(randomRisk()))
  const resultMode = spin.selectedId ? 'operator-controlled' : 'random'
  const fromRotation = spin.fromRotation + Math.max(0, now - spin.startedAt) * 0.72
  const toRotation = selectedRotation(wheel, selection, fromRotation)
  const resultLabel = wheel === 'main' ? findTeacher(selection)?.name ?? selection : `${selection}X`

  state.spin = {
    ...spin,
    phase: 'decelerating',
    startedAt: now + 150,
    durationMs: 2200,
    selectedId: selection,
    resultId: selection,
    resultMode,
    fromRotation,
    toRotation,
    pausedAt: undefined,
  }
  if (wheel === 'main') state.outerWheelRotation = toRotation
  else state.innerWheelRotation = toRotation
  if (wheel === 'main') state.outerSpinSequence += 1
  else state.innerSpinSequence += 1
  state.pausedWheel = null
  state.audienceMessage = `Selection locked: ${resultLabel}. The wheel is slowing down.`
  state.lastAction = `${wheel === 'main' ? 'Main' : 'Risk'} wheel selection locked`
  if (resultMode === 'operator-controlled') {
    state.auditLog.unshift({
      actionId: spin.selectionActionId ?? spin.actionId,
      action: wheel === 'main' ? 'teacher.spin' : 'risk.spin',
      actor: 'administrator',
      outcome: resultLabel,
      roundId: state.currentRound?.id ?? '',
      at: new Date(now).toISOString(),
    })
  }
  clearSpinTimer(`${wheel}:selection`)
  return true
}

function scheduleSpinTimers() {
  const spin = state.spin
  if (!spin) return
  if (spin.phase === 'selection' && !spin.pausedAt) {
    clearSpinTimer(`${spin.wheel}:selection`)
    spinTimers.set(`${spin.wheel}:selection`, setTimeout(() => {
      if (lockSpin(spin.wheel, true)) {
        updateTimedState()
        scheduleSpinTimers()
      }
    }, Math.max(0, spin.deadlineAt - Date.now())))
  } else if (spin.phase === 'decelerating') {
    clearSpinTimer(`${spin.wheel}:complete`)
    spinTimers.set(`${spin.wheel}:complete`, setTimeout(() => {
      if (completeSpin(spin.wheel)) updateTimedState()
    }, Math.max(0, spin.startedAt + spin.durationMs - Date.now())))
  }
}

function applyAdminUpdate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('Invalid settings update.')
  for (const key of ['currentRound', 'history', 'auditLog', 'currentStage', 'selectedTeacherRoll', 'outerWheelRotation', 'innerWheelRotation', 'outerSpinSequence', 'innerSpinSequence', 'spin']) {
    if (JSON.stringify(candidate[key]) !== JSON.stringify(state[key])) throw new Error(`Protected game field cannot be edited directly: ${key}`)
  }
  if (!Array.isArray(candidate.teachers) || !candidate.settings) {
    throw new Error('Invalid game settings or teacher update.')
  }
  if (candidate.teachers.filter((teacher) => teacher.isActive).length === 0) throw new Error('At least one teacher must remain active.')
  const stake = Number(candidate.currentStake)
  if (!Number.isInteger(stake) || stake < candidate.settings.minimumStake || stake > candidate.settings.maximumStake) {
    throw new Error('Stake must be a whole number within the configured limits.')
  }
  state = {
    ...state,
    gameTitle: String(candidate.gameTitle).slice(0, 80),
    eventName: String(candidate.eventName).slice(0, 100),
    teachers: candidate.teachers,
    settings: candidate.settings,
    selectedTeacherId: candidate.selectedTeacherId,
    currentStake: stake,
  }
}

function applyCommand(action, payload, actionId) {
  const round = state.currentRound
  switch (action) {
    case 'round.start': {
      if (round?.status === 'in-progress') throw new Error('An active round already exists.')
      const stake = Number(payload.stake)
      if (!Number.isInteger(stake) || stake < state.settings.minimumStake || stake > state.settings.maximumStake) {
        throw new Error(`Stake must be a whole number from ${state.settings.minimumStake} to ${state.settings.maximumStake}.`)
      }
      const newRound = {
        id: randomUUID(),
        actualTeacherId: null,
        originalStake: stake,
        stageOneResult: 'pending',
        stageTwoDecision: null,
        riskMultiplier: null,
        finalPayout: 0,
        status: 'in-progress',
        mainResultMode: null,
        riskResultMode: null,
        createdAt: new Date().toISOString(),
      }
      state = { ...state, currentRound: newRound, currentStage: 'teacher-spin', currentStake: stake, selectedTeacherRoll: null, spin: null, audienceMessage: `New event round started with a ${stake} point stake.`, lastAction: 'New round started' }
      break
    }
    case 'teacher.spin': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'teacher-spin' || state.spin || state.selectedTeacherRoll) throw new Error('The main wheel is not ready to spin.')
      if (state.teachers.length !== 12) throw new Error('The main wheel requires all 12 teachers.')
      startWheelSelection('main', actionId)
      break
    }
    case 'risk.spin': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'risk-spin' || state.spin || round.riskMultiplier !== null) throw new Error('The risk wheel is not ready to spin.')
      startWheelSelection('risk', actionId)
      break
    }
    case 'spin.select': {
      const spin = state.spin
      if (!spin || spin.phase !== 'selection' || spin.pausedAt || Date.now() >= spin.deadlineAt) throw new Error('The selection window is closed.')
      const selection = String(payload.selection ?? '')
      if (spin.wheel === 'main') {
        if (!findTeacher(selection)) throw new Error('Choose a teacher.')
      } else if (![0, 3, 4].includes(Number(selection))) {
        throw new Error('Choose 0X, 3X, or 4X.')
      }
      state.spin = { ...spin, selectedId: selection, selectionActionId: actionId }
      state.selectedTeacherId = spin.wheel === 'main' ? selection : state.selectedTeacherId
      state.audienceMessage = `Operator selection: ${spin.wheel === 'main' ? findTeacher(selection)?.name : `${selection}X`}.`
      state.lastAction = `${spin.wheel === 'main' ? 'Main' : 'Risk'} wheel selection changed`
      break
    }
    case 'teacher.confirm':
      if (!lockSpin('main')) throw new Error('There is no open main-wheel selection to confirm.')
      break
    case 'stage2.start':
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'stage2' || round.stageTwoDecision) throw new Error('Stage 2 is not ready.')
      state = { ...state, currentStage: 'risk-spin', spin: null, audienceMessage: 'The risk wheel selection window is ready.', lastAction: 'Risk wheel enabled' }
      break
    case 'round.collect': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'stage2' || round.stageTwoDecision) throw new Error('The 2X payout is not available.')
      const completed = { ...round, stageTwoDecision: 'collect', finalPayout: round.originalStake * state.settings.matchMultiplier }
      state = { ...state, currentRound: completed, spin: null, audienceMessage: `Final result: collected ${completed.finalPayout} points.`, lastAction: 'Collected 2X payout' }
      finishRound(completed)
      break
    }
    case 'risk.confirm': {
      if (state.spin?.wheel === 'risk' && lockSpin('risk')) break
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'risk-spin' || state.spin || round.riskMultiplier === null) throw new Error('There is no locked risk result to confirm.')
      const multiplier = round.riskMultiplier
      const completed = { ...round, stageTwoDecision: 'risk', finalPayout: round.originalStake * multiplier }
      state = { ...state, currentRound: completed, spin: null, audienceMessage: `Final risk result: ${multiplier}X for ${completed.finalPayout} points.`, lastAction: 'Risk wheel payout confirmed' }
      finishRound(completed)
      break
    }
    case 'wheel.pause':
      if (!['main', 'risk'].includes(payload.wheel)) throw new Error('Unknown wheel.')
      if (!state.spin || state.spin.wheel !== payload.wheel || state.spin.phase !== 'selection' || state.spin.pausedAt || Date.now() >= state.spin.deadlineAt) throw new Error('That wheel is not in its selection window.')
      state = { ...state, pausedWheel: payload.wheel, spin: { ...state.spin, pausedAt: Date.now() }, lastAction: `${payload.wheel} wheel paused` }
      clearSpinTimer(`${payload.wheel}:selection`)
      break
    case 'wheel.resume':
      if (!state.spin || state.spin.wheel !== payload.wheel || state.spin.phase !== 'selection' || !state.spin.pausedAt) throw new Error('That wheel is not paused.')
      {
        const pauseDuration = Date.now() - state.spin.pausedAt
        state = { ...state, pausedWheel: null, spin: { ...state.spin, startedAt: state.spin.startedAt + pauseDuration, deadlineAt: state.spin.deadlineAt + pauseDuration, pausedAt: undefined }, lastAction: `${payload.wheel} wheel resumed` }
      }
      scheduleSpinTimers()
      break
    case 'wheel.reset':
      if (!['main', 'risk'].includes(payload.wheel)) throw new Error('Unknown wheel.')
      if (!state.spin || state.spin.wheel !== payload.wheel || state.spin.phase !== 'selection' || Date.now() >= state.spin.deadlineAt) throw new Error('Only an open selection spin can be reset.')
      clearSpinTimer(`${payload.wheel}:selection`)
      if (payload.wheel === 'main') {
        state = { ...state, spin: null, selectedTeacherRoll: null, outerWheelStartRotation: state.outerWheelRotation, outerWheelRotation: 0, outerSpinSequence: state.outerSpinSequence + 1, pausedWheel: null, audienceMessage: 'Main wheel reset. Start the spin again.', lastAction: 'Main wheel reset' }
      } else {
        state = { ...state, spin: null, innerWheelStartRotation: state.innerWheelRotation, innerWheelRotation: 0, innerSpinSequence: state.innerSpinSequence + 1, pausedWheel: null, audienceMessage: 'Risk wheel reset. Start the spin again.', lastAction: 'Risk wheel reset' }
      }
      break
    case 'round.next':
      if (round?.status === 'in-progress') throw new Error('Finalize or cancel the active round before starting another.')
      state = { ...state, currentRound: null, currentStage: 'waiting', selectedTeacherRoll: null, spin: null, selectedTeacherId: null, currentStake: state.settings.defaultStake, outerWheelStartRotation: state.outerWheelRotation, innerWheelStartRotation: state.innerWheelRotation, pausedWheel: null, audienceMessage: 'Ready for the next event round.', lastAction: 'Prepared next round' }
      break
    case 'round.reset': {
      if (!round || round.status !== 'in-progress') throw new Error('There is no active round to reset.')
      const cancelled = { ...round, status: 'cancelled', finalPayout: 0 }
      clearSpinTimer('main:selection')
      clearSpinTimer('main:complete')
      clearSpinTimer('risk:selection')
      clearSpinTimer('risk:complete')
      state = { ...state, currentRound: cancelled, currentStage: 'final', spin: null, pausedWheel: null, audienceMessage: 'Round cancelled by the administrator. No payout was processed.', lastAction: `Round ${round.id} cancelled by administrator` }
      state.history.unshift({ ...cancelled, completedAt: new Date().toISOString() })
      break
    }
    case 'admin.state.update':
      applyAdminUpdate(payload.state)
      state = { ...state, lastAction: 'Admin configuration updated' }
      break
    default:
      throw new Error(`Unsupported action: ${action}`)
  }
  state.revision += 1
  state.serverTime = Date.now()
  state.syncMetrics.commands += 1
  scheduleSpinTimers()
  return state
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

function verifyOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

const httpServer = createServer(async (request, response) => {
  if (request.url?.startsWith('/ws')) {
    response.writeHead(426, { 'Content-Type': 'text/plain' }).end('WebSocket upgrade required')
    return
  }
  if (!production) {
    vite.middlewares(request, response)
    return
  }
  const requestedPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const relativePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  let filepath = join(root, 'dist', relativePath)
  if (!existsSync(filepath) || statSync(filepath).isDirectory()) filepath = join(root, 'dist', 'index.html')
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' }
  response.setHeader('Content-Type', contentTypes[extname(filepath)] ?? 'application/octet-stream')
  createReadStream(filepath).pipe(response)
})

const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 })
httpServer.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws' || !verifyOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request))
})

websocketServer.on('connection', (socket) => {
  clients.add(socket)
  socket.isAlive = true
  socket.authenticated = false
  socket.loginFailures = 0
  socket.lastSequence = 0
  send(socket, { type: 'connection', status: 'connected', state: publicState(), serverTime: Date.now() })

  socket.on('pong', () => { socket.isAlive = true })
  socket.on('message', async (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      send(socket, { type: 'error', error: 'Invalid message format.' })
      return
    }

    if (message.type === 'auth.login') {
      const valid = adminEmail && adminPassword && safeEqual(String(message.email ?? ''), adminEmail) && safeEqual(String(message.password ?? ''), adminPassword)
      if (!valid) {
        socket.loginFailures += 1
        send(socket, { type: 'ack', requestId: message.requestId, ok: false, error: 'Invalid administrator credentials.' })
        if (socket.loginFailures >= 8) socket.close(1008, 'Too many login attempts')
        return
      }
      const token = randomBytes(32).toString('base64url')
      sessions.set(token, Date.now() + 12 * 60 * 60 * 1000)
      socket.authenticated = true
      socket.token = token
      send(socket, { type: 'ack', requestId: message.requestId, ok: true, token, state: publicState() })
      return
    }

    if (message.type === 'auth.restore') {
      const expiry = sessions.get(message.token)
      if (expiry && expiry > Date.now()) {
        socket.authenticated = true
        socket.token = message.token
        send(socket, { type: 'ack', requestId: message.requestId, ok: true, state: publicState() })
      } else {
        sessions.delete(message.token)
        send(socket, { type: 'ack', requestId: message.requestId, ok: false, error: 'Admin session expired.' })
      }
      return
    }
    if (message.type === 'auth.logout') {
      socket.authenticated = false
      socket.token = undefined
      send(socket, { type: 'ack', requestId: message.requestId, ok: true })
      return
    }

    if (message.type === 'state.get') {
      send(socket, { type: 'state', state: publicState(), serverTime: Date.now() })
      return
    }
    if (message.type === 'heartbeat') {
      send(socket, { type: 'heartbeat', clientSentAt: Number(message.clientSentAt), serverTime: Date.now() })
      return
    }
    if (message.type === 'connection.reconnected') {
      const duration = Math.max(0, Math.min(Number(message.durationMs) || 0, 120000))
      state.syncMetrics.reconnects += 1
      state.syncMetrics.averageReconnectMs = Math.round(((state.syncMetrics.averageReconnectMs * (state.syncMetrics.reconnects - 1)) + duration) / state.syncMetrics.reconnects)
      state.syncMetrics.maxReconnectMs = Math.max(state.syncMetrics.maxReconnectMs, duration)
      broadcastState('state')
      return
    }

    if (message.type !== 'admin.command') return
    const sessionExpiry = sessions.get(socket.token)
    if (!socket.authenticated || !sessionExpiry || sessionExpiry <= Date.now()) {
      sessions.delete(socket.token)
      socket.authenticated = false
      send(socket, { type: 'ack', requestId: message.requestId, ok: false, error: 'Administrator authentication required.' })
      return
    }
    const actionId = String(message.actionId ?? '')
    const requestId = String(message.requestId ?? '')
    if (!actionId || !requestId || actionId.length > 100) {
      send(socket, { type: 'ack', requestId, ok: false, error: 'A unique action ID and request ID are required.' })
      return
    }
    if (processedActions.has(actionId)) {
      send(socket, { ...processedActions.get(actionId), requestId, duplicate: true })
      return
    }
    const sequence = Number(message.clientSequence)
    if (!Number.isSafeInteger(sequence) || sequence <= socket.lastSequence) {
      send(socket, { type: 'ack', requestId, actionId, ok: false, error: 'Command sequence is invalid or out of order.' })
      return
    }
    socket.lastSequence = sequence

    const receivedAt = Date.now()
    try {
      const nextState = applyCommand(String(message.action ?? ''), message.payload ?? {}, actionId)
      const latency = Math.max(0, Date.now() - receivedAt)
      const metrics = nextState.syncMetrics
      metrics.averageLatencyMs = Math.round(((metrics.averageLatencyMs * (metrics.commands - 1)) + latency) / metrics.commands)
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latency)
      const ack = { type: 'ack', requestId, actionId, ok: true, revision: nextState.revision, serverTime: Date.now(), latencyMs: latency }
      processedActions.set(actionId, ack)
      if (processedActions.size > 20000) processedActions.delete(processedActions.keys().next().value)
      send(socket, ack)
      broadcastState('state')
    } catch (error) {
      state.syncMetrics.failedCommands += 1
      state.revision += 1
      state.serverTime = Date.now()
      const errorAck = { type: 'ack', requestId, actionId, ok: false, error: error.message, serverTime: Date.now() }
      processedActions.set(actionId, errorAck)
      send(socket, errorAck)
      broadcastState('state')
    }
  })

  socket.on('close', () => clients.delete(socket))
  socket.on('error', (error) => console.error('WebSocket client error:', error.message))
})

const heartbeat = setInterval(() => {
  for (const socket of clients) {
    if (!socket.isAlive) {
      socket.terminate()
      clients.delete(socket)
      continue
    }
    socket.isAlive = false
    socket.ping()
  }
}, 15000)

async function start() {
  if (!production) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
  }
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Teacher Roulette ${production ? 'production' : 'development'} server listening at http://0.0.0.0:${port}`)
    console.log('Use this computer’s LAN IP from the phone; both devices must use the same host.')
    if (!adminEmail || !adminPassword) console.warn('Admin login disabled: set ADMIN_EMAIL and ADMIN_PASSWORD in .env.local before event use.')
    if (!process.env.NODE_ENV && !production) console.warn('Local dev mode only. Configure TLS/reverse proxy before exposing outside trusted network.')
  })
}

process.on('SIGINT', async () => {
  clearInterval(heartbeat)
  for (const socket of clients) socket.close(1001, 'Server shutting down')
  if (vite) await vite.close()
  httpServer.close(() => process.exit(0))
})

start().catch((error) => {
  console.error('Unable to start Teacher Roulette server:', error)
  process.exitCode = 1
})
