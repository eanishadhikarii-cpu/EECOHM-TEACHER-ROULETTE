import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
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
    currentStake: 0,
    teacherBets: Object.fromEntries(seedTeachers.map((_, index) => [`teacher-${index + 1}`, 0])),
    bets: [],
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
    for (const [actionId, acknowledgement] of (saved._processedActions ?? []).slice(-20000)) {
      if (typeof actionId === 'string' && actionId && acknowledgement && typeof acknowledgement === 'object') {
        processedActions.set(actionId, acknowledgement)
      }
    }
    delete saved._processedActions
    const defaults = createInitialState()
    const restored = {
      ...defaults,
      ...saved,
      settings: { ...defaults.settings, ...saved.settings },
      revision: Number(saved.revision) || 0,
    }
    if (!Array.isArray(restored.teachers) || restored.teachers.length === 0) restored.teachers = defaults.teachers
    restored.bets = normalizeBets(saved.bets, saved.teacherBets, restored.teachers, restored.settings.maximumStake)
    restored.teacherBets = aggregateBets(restored.bets, restored.teachers)
    restored.currentStake = restored.bets.reduce((total, bet) => total + bet.stake, 0)
    delete restored.players
    delete restored.currentPlayerId
    delete restored.recentWinners
    delete restored.settings.leaderboardEnabled
    delete restored.settings.recentWinnersEnabled
    delete restored.settings.manualDemoMode
    delete restored.settings.randomOutcomeMode
    delete restored.settings.wheelSpinDuration
    delete restored.settings.animationSpeed
    restored.history = Array.isArray(restored.history)
      ? restored.history.map((round) => stripPlayerFields(round, restored.teachers, restored.settings.maximumStake))
      : []
    restored.currentRound = restored.currentRound
      ? stripPlayerFields(restored.currentRound, restored.teachers, restored.settings.maximumStake)
      : null
    if (restored.currentStage === 'bet') restored.currentStage = restored.currentRound ? 'teacher-spin' : 'waiting'
    if (restored.spin && (!restored.spin.phase || !restored.spin.deadlineAt)) restored.spin = null
    return restored
  } catch (error) {
    if (error.code === 'ENOENT') return createInitialState()
    console.error('Unable to restore game state:', error)
    throw error
  }
}

function normalizeBets(records, legacyTotals, teachers, maximumStake) {
  const source = Array.isArray(records)
    ? records
    : Object.entries(legacyTotals ?? {}).map(([teacherId, stake]) => ({ teacherId, stake }))
  const ids = new Set()
  return source.flatMap((record) => {
    const teacherId = String(record?.teacherId ?? '')
    const stake = Number(record?.stake)
    if (!teachers.some((teacher) => teacher.id === teacherId)
      || !Number.isSafeInteger(stake)
      || stake <= 0
      || stake > maximumStake) return []
    let id = String(record.id ?? '')
    if (!id || ids.has(id)) id = randomUUID()
    ids.add(id)
    return [{
      id,
      teacherId,
      stake,
      decision: record.decision === 'collect' || record.decision === 'risk' ? record.decision : null,
      payout: Number.isSafeInteger(record.payout) && record.payout >= 0 ? record.payout : 0,
    }]
  })
}

function aggregateBets(bets, teachers) {
  const totals = Object.fromEntries(teachers.map((teacher) => [teacher.id, 0]))
  for (const bet of bets) totals[bet.teacherId] = (totals[bet.teacherId] ?? 0) + bet.stake
  return totals
}

function stripPlayerFields(round, teachers = seedTeachers.map(([name], index) => ({ id: `teacher-${index + 1}`, name })), maximumStake = 500) {
  const { playerId, playerName, selectedTeacherId, resultMode, ...cleanRound } = round
  void playerId
  void playerName
  void selectedTeacherId
  void resultMode
  const legacyBetRecords = Array.isArray(cleanRound.bets)
    ? cleanRound.bets
    : Object.entries(cleanRound.teacherBets ?? {}).map(([teacherId, stake]) => ({
        teacherId,
        stake,
        payout: teacherId === cleanRound.actualTeacherId ? cleanRound.finalPayout : 0,
      }))
  const bets = normalizeBets(legacyBetRecords, null, teachers, maximumStake)
  return {
    ...cleanRound,
    bets,
    teacherBets: aggregateBets(bets, teachers),
    originalStake: bets.reduce((total, bet) => total + bet.stake, 0),
    finalPayout: bets.reduce((total, bet) => total + bet.payout, 0),
    stageOneResult: cleanRound.actualTeacherId ? 'selected' : 'pending',
    mainResultMode: cleanRound.mainResultMode ?? (cleanRound.actualTeacherId ? resultMode === 'manual' ? 'operator-controlled' : 'random' : null),
    riskResultMode: cleanRound.riskResultMode ?? (cleanRound.riskMultiplier !== null ? resultMode === 'manual' ? 'operator-controlled' : 'random' : null),
  }
}

let state = readState()

function persistState() {
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify({
      ...state,
      _processedActions: Array.from(processedActions.entries()).slice(-20000),
    }, null, 2), 'utf8')
    renameSync(temporaryPath, statePath)
  } catch (error) {
    console.error('Unable to persist game state:', error)
    try {
      unlinkSync(temporaryPath)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Unable to remove temporary game state:', cleanupError)
    }
    throw error
  }
}

persistState()

function publicState(socket) {
  const snapshot = { ...state, serverTime: Date.now() }
  if (socket?.authenticated) return snapshot

  const hiddenBets = Object.fromEntries(state.teachers.map((teacher) => [teacher.id, 0]))
  const publicSpin = state.spin ? {
    ...state.spin,
    selectedId: null,
    resultId: null,
    resultMode: null,
    selectionActionId: null,
  } : undefined
  return {
    ...snapshot,
    currentStake: 0,
    teacherBets: hiddenBets,
    bets: [],
    currentRound: state.currentRound
      ? { ...state.currentRound, originalStake: 0, teacherBets: hiddenBets, bets: [] }
      : null,
    history: [],
    auditLog: [],
    selectedTeacherId: state.spin?.wheel === 'main' ? null : state.selectedTeacherId,
    spin: publicSpin,
    audienceMessage: state.spin?.phase === 'selection'
      ? 'The wheel is spinning. The winning selection is private until it stops.'
      : state.audienceMessage,
  }
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function broadcastState(event = 'state', shouldPersist = true) {
  state.serverTime = Date.now()
  if (shouldPersist) persistState()
  for (const socket of clients) {
    send(socket, { type: event, state: publicState(socket), serverTime: Date.now() })
  }
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

function winningStake(round) {
  return round?.actualTeacherId
    ? round.bets.filter((bet) => bet.teacherId === round.actualTeacherId).reduce((total, bet) => total + bet.stake, 0)
    : 0
}

function winningBets(round) {
  return round?.actualTeacherId ? round.bets.filter((bet) => bet.teacherId === round.actualTeacherId) : []
}

function settleRound(round, riskMultiplier = null) {
  if (!round || round.status !== 'in-progress') throw new Error('This round has already been finalized.')
  const bets = round.bets.map((bet) => ({
    ...bet,
    payout: bet.decision === 'collect'
      ? bet.stake * state.settings.matchMultiplier
      : bet.decision === 'risk' && riskMultiplier !== null
        ? bet.stake * riskMultiplier
        : 0,
  }))
  const finalPayout = bets.reduce((total, bet) => total + bet.payout, 0)
  return {
    ...round,
    bets,
    riskMultiplier,
    finalPayout,
    stageTwoDecision: bets.some((bet) => bet.decision === 'risk')
      ? bets.some((bet) => bet.decision === 'collect') ? 'mixed' : 'risk'
      : 'collect',
  }
}

function formatPoints(amount) {
  return `${amount.toLocaleString()} points`
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
  scheduleRoundReturn()
}

let roundReturnTimer

function returnToMainAfterFinal() {
  if (state.currentStage !== 'final' || !['completed', 'cancelled'].includes(state.currentRound?.status)) return
  state = {
    ...state,
    currentRound: null,
    currentStage: 'waiting',
    selectedTeacherId: null,
    selectedTeacherRoll: null,
    currentStake: 0,
    teacherBets: Object.fromEntries(state.teachers.map((teacher) => [teacher.id, 0])),
    bets: [],
    spin: null,
    pausedWheel: null,
    audienceMessage: 'Ready for the next event round.',
    lastAction: 'Returned to the main game after the result',
    revision: state.revision + 1,
  }
  broadcastState('state')
}

function scheduleRoundReturn() {
  clearTimeout(roundReturnTimer)
  roundReturnTimer = setTimeout(returnToMainAfterFinal, 5000)
}

if (state.currentStage === 'final' && ['completed', 'cancelled'].includes(state.currentRound?.status)) scheduleRoundReturn()

function startWheelSelection(wheel, actionId) {
  const now = Date.now()
  const startedAt = now + 250
  const durationMs = 10000
  const fromRotation = wheel === 'main' ? state.outerWheelRotation : state.innerWheelRotation
  state.spin = {
    wheel,
    phase: 'selection',
    actionId,
    startedAt,
    durationMs,
    deadlineAt: startedAt + durationMs,
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
  state.audienceMessage = `${wheel === 'main' ? 'Main' : 'Risk'} wheel selection is open for 10 seconds.`
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
    const eligibleBets = round.bets.filter((bet) => bet.teacherId === teacher.id)
    const eligibleStake = eligibleBets.reduce((total, bet) => total + bet.stake, 0)
    state.currentRound = {
      ...round,
      actualTeacherId: teacher.id,
      stageOneResult: 'selected',
      mainResultMode: spin.resultMode,
      finalPayout: 0,
    }
    state.selectedTeacherRoll = teacher.id
    state.currentStage = eligibleStake > 0 ? 'stage2' : 'no-winners'
    state.audienceMessage = eligibleStake > 0
      ? `Winning teacher: ${teacher.name}. ${eligibleBets.length} anonymous bets are eligible for individual collect-or-risk decisions.`
      : `NO WINNING BETS ON THIS TEACHER! No bets were placed on ${teacher.name}.`
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

scheduleSpinTimers()

function applyAdminUpdate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('Invalid settings update.')
  for (const key of ['currentRound', 'history', 'auditLog', 'currentStage', 'selectedTeacherRoll', 'outerWheelRotation', 'innerWheelRotation', 'outerSpinSequence', 'innerSpinSequence', 'spin', 'bets', 'teacherBets', 'currentStake']) {
    if (JSON.stringify(candidate[key]) !== JSON.stringify(state[key])) throw new Error(`Protected game field cannot be edited directly: ${key}`)
  }
  if (!Array.isArray(candidate.teachers) || !candidate.settings) {
    throw new Error('Invalid game settings or teacher update.')
  }
  if (candidate.teachers.filter((teacher) => teacher.isActive).length === 0) throw new Error('At least one teacher must remain active.')
  const maximumStake = Number(candidate.settings.maximumStake)
  const minimumStake = Number(candidate.settings.minimumStake)
  const defaultStake = Number(candidate.settings.defaultStake)
  const matchMultiplier = Number(candidate.settings.matchMultiplier)
  if (!Number.isSafeInteger(minimumStake) || minimumStake <= 0
    || !Number.isSafeInteger(defaultStake) || defaultStake < minimumStake
    || !Number.isSafeInteger(maximumStake) || maximumStake < defaultStake
    || !Number.isFinite(matchMultiplier) || matchMultiplier <= 0) {
    throw new Error('Bet limits must be positive whole numbers with minimum <= default <= maximum; the match multiplier must be positive.')
  }
  if (state.bets.some((bet) => bet.stake < minimumStake || bet.stake > maximumStake)) {
    throw new Error('Bet limits cannot exclude a bet that has already been entered.')
  }
  const stake = state.bets.reduce((total, bet) => total + bet.stake, 0)
  state = {
    ...state,
    gameTitle: String(candidate.gameTitle).slice(0, 80),
    eventName: String(candidate.eventName).slice(0, 100),
    teachers: candidate.teachers,
    settings: candidate.settings,
    selectedTeacherId: candidate.selectedTeacherId,
    teacherBets: aggregateBets(state.bets, candidate.teachers),
    currentStake: stake,
  }
}

function applyCommand(action, payload, actionId) {
  const round = state.currentRound
  switch (action) {
    case 'admin.bet.add': {
      if (state.currentStage !== 'waiting' || round?.status === 'in-progress') throw new Error('Bets can only be updated between rounds.')
      const teacher = findTeacher(String(payload.teacherId ?? ''), true)
      const amount = Number(payload.amount)
      if (!teacher) throw new Error('Choose an active teacher for this bet.')
      if (!Number.isSafeInteger(amount) || amount < state.settings.minimumStake || amount > state.settings.maximumStake) {
        throw new Error(`Each anonymous bet must be a whole number from ${state.settings.minimumStake} to ${state.settings.maximumStake}.`)
      }
      if (!Number.isSafeInteger(state.currentStake + amount)) throw new Error('The combined stake exceeds the supported total.')
      const bet = { id: randomUUID(), teacherId: teacher.id, stake: amount, decision: null, payout: 0 }
      const bets = [...state.bets, bet]
      state = {
        ...state,
        bets,
        teacherBets: aggregateBets(bets, state.teachers),
        currentStake: bets.reduce((total, currentBet) => total + currentBet.stake, 0),
        lastAction: `Recorded anonymous bet on ${teacher.name}`,
      }
      break
    }
    case 'admin.bet.remove': {
      if (state.currentStage !== 'waiting' || round?.status === 'in-progress') throw new Error('Bets can only be updated between rounds.')
      const bets = state.bets.filter((bet) => bet.id !== String(payload.betId ?? ''))
      if (bets.length === state.bets.length) throw new Error('That anonymous bet no longer exists.')
      state = {
        ...state,
        bets,
        teacherBets: aggregateBets(bets, state.teachers),
        currentStake: bets.reduce((total, bet) => total + bet.stake, 0),
        lastAction: 'Removed an anonymous bet',
      }
      break
    }
    case 'round.start': {
      if (state.currentStage !== 'waiting') throw new Error('Wait until the game is ready before starting another round.')
      if (round?.status === 'in-progress') throw new Error('An active round already exists.')
      clearTimeout(roundReturnTimer)
      const bets = state.bets.map((bet) => ({ ...bet, decision: null, payout: 0 }))
      const teacherBets = aggregateBets(bets, state.teachers)
      const stake = bets.reduce((total, bet) => total + bet.stake, 0)
      if (stake <= 0) throw new Error('Record at least one anonymous bet before starting a round.')
      const newRound = {
        id: randomUUID(),
        actualTeacherId: null,
        originalStake: stake,
        teacherBets,
        bets,
        stageOneResult: 'pending',
        stageTwoDecision: null,
        riskMultiplier: null,
        finalPayout: 0,
        status: 'in-progress',
        mainResultMode: null,
        riskResultMode: null,
        createdAt: new Date().toISOString(),
      }
      state = { ...state, currentRound: newRound, currentStage: 'teacher-spin', currentStake: stake, selectedTeacherRoll: null, spin: null, audienceMessage: `New event round started with ${bets.length} anonymous bets totaling ${stake} points.`, lastAction: 'New round started' }
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
      state.audienceMessage = 'The wheel is spinning. The winning selection is private until it stops.'
      state.lastAction = `${spin.wheel === 'main' ? 'Main' : 'Risk'} wheel selection changed`
      break
    }
    case 'teacher.confirm':
      if (!lockSpin('main')) throw new Error('There is no open main-wheel selection to confirm.')
      break
    case 'round.bet.decision': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'stage2' || round.stageTwoDecision) {
        throw new Error('Individual collect-or-risk decisions are only open after the main wheel stops.')
      }
      const betId = String(payload.betId ?? '')
      const decision = payload.decision
      if (decision !== 'collect' && decision !== 'risk') throw new Error('Choose collect or risk for this bet.')
      if (!winningBets(round).some((bet) => bet.id === betId)) throw new Error('That bet is not eligible for this teacher result.')
      const bets = round.bets.map((bet) => bet.id === betId ? { ...bet, decision } : bet)
      state.currentRound = { ...round, bets }
      state.audienceMessage = 'The team is recording anonymous collect-or-risk choices.'
      state.lastAction = 'Updated an anonymous bet decision'
      break
    }
    case 'round.decisions.confirm': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'stage2' || round.stageTwoDecision) {
        throw new Error('There are no open bet decisions to confirm.')
      }
      const eligibleBets = winningBets(round)
      if (!eligibleBets.length || eligibleBets.some((bet) => !bet.decision)) {
        throw new Error('Choose collect or risk for every eligible bet before confirming.')
      }
      const riskBets = eligibleBets.filter((bet) => bet.decision === 'risk')
      if (riskBets.length) {
        const hasCollectBets = eligibleBets.some((bet) => bet.decision === 'collect')
        state.currentRound = {
          ...round,
          stageTwoDecision: hasCollectBets ? 'mixed' : 'risk',
          audienceMessage: `${riskBets.length} anonymous bets are advancing to the risk wheel.`,
        }
        state.currentStage = 'risk-spin'
        state.spin = null
        state.lastAction = 'Confirmed individual collect-or-risk decisions'
        break
      }
      const completed = settleRound({ ...round, stageTwoDecision: 'collect' })
      state = {
        ...state,
        currentRound: completed,
        audienceMessage: `All winning bets collect ${state.settings.matchMultiplier}X. Final payout: ${formatPoints(completed.finalPayout)}.`,
        lastAction: `Confirmed individual ${state.settings.matchMultiplier}X payouts`,
      }
      finishRound(completed)
      break
    }
    case 'round.no-winners.confirm': {
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'no-winners' || winningStake(round) !== 0) throw new Error('This round does not have a no-winning-bets result to confirm.')
      const completed = { ...round, stageTwoDecision: 'no-winners', bets: round.bets.map((bet) => ({ ...bet, payout: 0 })), finalPayout: 0 }
      state = { ...state, currentRound: completed, audienceMessage: `No winning bets. ${findTeacher(round.actualTeacherId)?.name ?? 'The selected teacher'} was not backed.`, lastAction: 'Confirmed no winning bets' }
      finishRound(completed)
      break
    }
    case 'risk.confirm': {
      if (state.spin?.wheel === 'risk' && lockSpin('risk')) break
      if (!round || round.status !== 'in-progress' || state.currentStage !== 'risk-spin' || state.spin || round.riskMultiplier === null) throw new Error('There is no locked risk result to confirm.')
      const multiplier = round.riskMultiplier
      const riskStake = winningBets(round).filter((bet) => bet.decision === 'risk').reduce((total, bet) => total + bet.stake, 0)
      const completed = settleRound(round, multiplier)
      state = { ...state, currentRound: completed, spin: null, audienceMessage: `Final risk result: ${multiplier}X on ${formatPoints(riskStake)} risk stake. Total payout: ${formatPoints(completed.finalPayout)}.`, lastAction: 'Risk wheel payout confirmed' }
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
      clearTimeout(roundReturnTimer)
      state = { ...state, currentRound: null, currentStage: 'waiting', selectedTeacherRoll: null, spin: null, selectedTeacherId: null, currentStake: 0, teacherBets: Object.fromEntries(state.teachers.map((teacher) => [teacher.id, 0])), bets: [], outerWheelStartRotation: state.outerWheelRotation, innerWheelStartRotation: state.innerWheelRotation, pausedWheel: null, audienceMessage: 'Ready for the next event round. Record anonymous bets to begin.', lastAction: 'Prepared next round' }
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
      scheduleRoundReturn()
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
    const parsedOrigin = new URL(origin).origin
    const allowedOrigins = [
      process.env.FRONTEND_ORIGIN,
      ...(process.env.ALLOWED_ORIGINS ?? '').split(','),
    ].map((value) => value?.trim()).filter(Boolean)
    return allowedOrigins.length
      ? allowedOrigins.includes(parsedOrigin)
      : parsedOrigin === `${request.headers['x-forwarded-proto'] ?? 'http'}://${request.headers.host}`
  } catch {
    return false
  }
}

const httpServer = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }).end(JSON.stringify({ status: 'ok', revision: state.revision, serverTime: Date.now() }))
    return
  }
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
  send(socket, { type: 'connection', status: 'connected', state: publicState(socket), serverTime: Date.now() })

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
      send(socket, { type: 'ack', requestId: message.requestId, ok: true, token, state: publicState(socket) })
      return
    }

    if (message.type === 'auth.restore') {
      const expiry = sessions.get(message.token)
      if (expiry && expiry > Date.now()) {
        socket.authenticated = true
        socket.token = message.token
        send(socket, { type: 'ack', requestId: message.requestId, ok: true, state: publicState(socket) })
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
      send(socket, { type: 'state', state: publicState(socket), serverTime: Date.now() })
      return
    }
    if (message.type === 'heartbeat') {
      send(socket, { type: 'heartbeat', clientSentAt: Number(message.clientSentAt), serverTime: Date.now() })
      return
    }
    if (message.type === 'connection.reconnected') {
      if (!socket.authenticated || !sessions.has(socket.token)) return
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
    const previousState = structuredClone(state)
    try {
      const nextState = applyCommand(String(message.action ?? ''), message.payload ?? {}, actionId)
      const latency = Math.max(0, Date.now() - receivedAt)
      const metrics = nextState.syncMetrics
      metrics.averageLatencyMs = Math.round(((metrics.averageLatencyMs * (metrics.commands - 1)) + latency) / metrics.commands)
      metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latency)
      const ack = { type: 'ack', requestId, actionId, ok: true, revision: nextState.revision, serverTime: Date.now(), latencyMs: latency }
      processedActions.set(actionId, ack)
      if (processedActions.size > 20000) processedActions.delete(processedActions.keys().next().value)
      persistState()
      send(socket, ack)
      broadcastState('state', false)
    } catch (error) {
      state = previousState
      processedActions.delete(actionId)
      for (const key of spinTimers.keys()) clearSpinTimer(key)
      scheduleSpinTimers()
      state.syncMetrics.failedCommands += 1
      state.revision += 1
      state.serverTime = Date.now()
      const errorAck = { type: 'ack', requestId, actionId, ok: false, error: error.message, serverTime: Date.now() }
      processedActions.set(actionId, errorAck)
      persistState()
      send(socket, errorAck)
      broadcastState('state', false)
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
