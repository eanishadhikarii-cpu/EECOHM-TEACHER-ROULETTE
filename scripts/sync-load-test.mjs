import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'

const url = process.env.TEST_WS_URL ?? 'ws://127.0.0.1:5173/ws'
const email = process.env.ADMIN_EMAIL
const password = process.env.ADMIN_PASSWORD
if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD for the synchronization test.')

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.latestState = null
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString())
        if (message.state) socket.latestState = message.state
      } catch {
        // The request listener reports malformed protocol responses separately.
      }
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function listen(socket) {
  const pending = new Map()
  const stateWaiters = []
  let latestState = socket.latestState
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.state) {
      latestState = message.state
      socket.latestState = message.state
      for (let index = stateWaiters.length - 1; index >= 0; index -= 1) {
        if (stateWaiters[index].predicate(latestState)) {
          stateWaiters.splice(index, 1)[0].resolve(latestState)
        }
      }
    }
    const request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    if (message.ok === false) request.reject(new Error(message.error))
    else request.resolve(message)
  })
  const request = (type, payload = {}, actionId) => new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Timed out waiting for ${type}.`))
    }, 5000)
    pending.set(requestId, {
      resolve: (message) => { clearTimeout(timer); resolve(message) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    socket.send(JSON.stringify({
      type,
      requestId,
      ...payload,
      ...(type === 'admin.command' ? {
        actionId: actionId ?? randomUUID(),
        clientSequence: ++sequence,
        clientSentAt: Date.now(),
      } : {}),
    }))
  })
  request.waitForState = (predicate = () => true) => latestState && predicate(latestState)
    ? Promise.resolve(latestState)
    : new Promise((resolve) => stateWaiters.push({ predicate, resolve }))
  return request
}

let sequence = 0
let socket = await connect()
let request = listen(socket)
const login = await request('auth.login', { email, password })
if (!login.ok) throw new Error('Admin login failed.')
const initialState = login.state
const initialHistory = initialState.history.length
const initialAuditCount = initialState.auditLog.length
const initialFailedCommands = initialState.syncMetrics.failedCommands
const timings = []
let spins = 0
let rejectedCommands = 0
let publicSocket = await connect()
let publicRequest = listen(publicSocket)
const publicInitialState = await publicRequest.waitForState()
if (Object.values(publicInitialState.teacherBets).some((amount) => amount !== 0)
  || publicInitialState.bets.length !== 0) {
  throw new Error('Public state exposed anonymous bet records or totals.')
}

const measuredCommand = async (action, payload = {}, actionId) => {
  const start = performance.now()
  const ack = await request('admin.command', { action, payload }, actionId)
  timings.push(performance.now() - start)
  return ack
}
const expectRejected = async (action, payload) => {
  try {
    await measuredCommand(action, payload)
  } catch {
    rejectedCommands += 1
    return
  }
  throw new Error(`${action} unexpectedly succeeded when the server should reject it.`)
}
const waitForSpin = async (predicate) => request.waitForState((next) => next.spin && predicate(next.spin))
const addBets = async (bets) => {
  for (const bet of bets) {
    await measuredCommand('admin.bet.add', { teacherId: bet.teacherId, amount: bet.amount })
  }
}
const assertWheelTarget = (spin, total, index) => {
  const segment = 360 / total
  const expected = (360 - (index * segment + segment / 2) % 360) % 360
  const actual = ((spin.toRotation % 360) + 360) % 360
  const difference = Math.min(Math.abs(actual - expected), 360 - Math.abs(actual - expected))
  if (difference > 0.001) throw new Error(`${spin.wheel} wheel target does not center the selected segment under the pointer.`)
}

await expectRejected('admin.bet.add', { teacherId: 'teacher-2', amount: 19 })
await expectRejected('admin.bet.add', { teacherId: 'teacher-2', amount: 501 })
await addBets([
  { teacherId: 'teacher-2', amount: 100 },
  { teacherId: 'teacher-2', amount: 50 },
  { teacherId: 'teacher-3', amount: 40 },
])
const configuredBets = await request.waitForState((next) => next.bets.length === 3)
if (configuredBets.currentStake !== 190 || configuredBets.teacherBets['teacher-2'] !== 150) {
  throw new Error('Separate bets did not aggregate correctly by teacher.')
}
await measuredCommand('round.start')
const activeBetIds = (await request.waitForState((next) => next.currentRound?.bets.length === 3)).currentRound.bets
if (new Set(activeBetIds.map((bet) => bet.id)).size !== 3 || activeBetIds.some((bet) => bet.decision !== null)) {
  throw new Error('Round did not snapshot unique anonymous bets with pending decisions.')
}
for (let index = 0; index < 25; index += 1) {
  await measuredCommand('teacher.spin')
  await measuredCommand('wheel.reset', { wheel: 'main' })
  spins += 1
}
await measuredCommand('teacher.spin')
spins += 1
const mainStarted = await waitForSpin((spin) => spin.wheel === 'main' && spin.phase === 'selection')
const mainStartedAt = mainStarted.spin.startedAt
const mainDeadline = mainStarted.spin.deadlineAt
if (mainDeadline - mainStartedAt !== 10000) throw new Error('Main selection window is not exactly 10 seconds.')
await measuredCommand('spin.select', { selection: 'teacher-3' })
const adminDisconnectStartedAt = performance.now()
socket.terminate()
await new Promise((resolve) => setTimeout(resolve, 50))
socket = await connect()
request = listen(socket)
const adminRestore = await request('auth.restore', { token: login.token })
const adminRecoveryState = adminRestore.state
if (adminRecoveryState.spin?.selectedId !== 'teacher-3' || adminRecoveryState.spin.phase !== 'selection') {
  throw new Error('Admin reconnect did not restore the active spin and private selection.')
}
const adminDisconnectRecoveryMs = performance.now() - adminDisconnectStartedAt
const publicDuringSelection = await publicRequest.waitForState((next) => next.revision > mainStarted.revision && next.spin?.wheel === 'main' && next.spin.phase === 'selection')
if (publicDuringSelection.spin.selectedId !== null || Object.values(publicDuringSelection.teacherBets).some((amount) => amount !== 0)
  || publicDuringSelection.bets.length !== 0 || publicDuringSelection.currentRound.bets.length !== 0) {
  throw new Error('Public state exposed the operator selection or private bet records.')
}
await measuredCommand('spin.select', { selection: 'teacher-2' })
await measuredCommand('wheel.pause', { wheel: 'main' })
const pausedMain = await request.waitForState((next) => next.pausedWheel === 'main')
await new Promise((resolve) => setTimeout(resolve, 1200))
await measuredCommand('wheel.resume', { wheel: 'main' })
const resumedMain = await request.waitForState((next) => next.spin?.wheel === 'main' && !next.pausedWheel)
const pauseExtensionMs = resumedMain.spin.deadlineAt - pausedMain.spin.deadlineAt
if (pauseExtensionMs < 1000) throw new Error('Pausing did not preserve the remaining selection time.')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, resumedMain.spin.deadlineAt - Date.now() + 100)))
const mainLocked = await waitForSpin((spin) => spin.wheel === 'main' && spin.phase === 'decelerating')
if (mainLocked.spin.resultId !== 'teacher-2' || mainLocked.spin.resultMode !== 'operator-controlled') {
  throw new Error('Main wheel did not lock the latest operator selection.')
}
const publicDuringDeceleration = await publicRequest.waitForState((next) => next.spin?.wheel === 'main' && next.spin.phase === 'decelerating')
if (publicDuringDeceleration.spin.resultId !== null || publicDuringDeceleration.spin.selectedId !== null) {
  throw new Error('Public state exposed a wheel outcome before the spin stopped.')
}
assertWheelTarget(mainLocked.spin, 12, 1)
await expectRejected('spin.select', { selection: 'teacher-4' })
await new Promise((resolve) => setTimeout(resolve, Math.max(0, mainLocked.spin.startedAt + mainLocked.spin.durationMs - Date.now() + 100)))
const mainStopped = await request.waitForState((next) => next.currentStage === 'stage2' && !next.spin)
if (mainStopped.currentRound.actualTeacherId !== 'teacher-2') throw new Error('Main wheel stopped at a different teacher.')
if (mainStopped.currentRound.originalStake !== 190
  || mainStopped.currentRound.teacherBets['teacher-2'] !== 150
  || mainStopped.currentRound.bets.length !== 3) {
  throw new Error('Main round did not preserve each original anonymous stake.')
}

const winningBets = mainStopped.currentRound.bets.filter((bet) => bet.teacherId === 'teacher-2')
await expectRejected('round.decisions.confirm', {})
await measuredCommand('round.bet.decision', { betId: winningBets[0].id, decision: 'collect' })
await measuredCommand('round.bet.decision', { betId: winningBets[1].id, decision: 'risk' })
await measuredCommand('round.decisions.confirm')
await request.waitForState((next) => next.currentStage === 'risk-spin')
for (let index = 0; index < 25; index += 1) {
  await measuredCommand('risk.spin')
  await measuredCommand('wheel.reset', { wheel: 'risk' })
  spins += 1
}
await measuredCommand('risk.spin')
spins += 1
const riskStarted = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'selection')
if (riskStarted.spin.deadlineAt - riskStarted.spin.startedAt !== 10000) throw new Error('Risk selection window is not exactly 10 seconds.')
const audienceDisconnectStartedAt = performance.now()
publicSocket.terminate()
await new Promise((resolve) => setTimeout(resolve, 50))
publicSocket = await connect()
publicRequest = listen(publicSocket)
const audienceRecoveryState = await publicRequest.waitForState((next) => next.currentStage === 'risk-spin' && next.spin?.wheel === 'risk')
const audienceDisconnectRecoveryMs = performance.now() - audienceDisconnectStartedAt
if (audienceRecoveryState.bets.length !== 0 || audienceRecoveryState.currentRound.bets.length !== 0) {
  throw new Error('Audience reconnect exposed private anonymous bets.')
}
await measuredCommand('spin.select', { selection: '3' })
const riskSelected = await request.waitForState((next) => next.spin?.wheel === 'risk' && next.spin.selectedId === '3')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, riskSelected.spin.deadlineAt - Date.now() + 100)))
const riskLocked = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'decelerating')
if (riskLocked.spin.resultId !== '3' || riskLocked.spin.resultMode !== 'operator-controlled') {
  throw new Error('Risk wheel did not lock the selected multiplier.')
}
assertWheelTarget(riskLocked.spin, 3, 1)
await expectRejected('spin.select', { selection: '4' })
await new Promise((resolve) => setTimeout(resolve, Math.max(0, riskLocked.spin.startedAt + riskLocked.spin.durationMs - Date.now() + 100)))
await request.waitForState((next) => next.currentRound?.riskMultiplier === 3 && !next.spin)
const payoutActionId = 'individual-bet-payout-restart-deduplication-check'
await measuredCommand('risk.confirm', {}, payoutActionId)
const duplicatePayout = await measuredCommand('risk.confirm', {}, payoutActionId)
if (!duplicatePayout.duplicate) throw new Error('Duplicate payout action was not acknowledged as a duplicate.')
await expectRejected('risk.confirm', {})
const completed = await request.waitForState((next) => next.currentRound?.status === 'completed')
if (completed.currentRound.finalPayout !== 350
  || completed.currentRound.bets.find((bet) => bet.id === winningBets[0].id)?.payout !== 200
  || completed.currentRound.bets.find((bet) => bet.id === winningBets[1].id)?.payout !== 150) {
  throw new Error('Mixed individual collect and risk payouts were not calculated from each original stake.')
}

await measuredCommand('round.next')
await addBets(Array.from({ length: 12 }, (_, index) => ({ teacherId: `teacher-${index + 1}`, amount: 20 })))
await measuredCommand('round.start')
await measuredCommand('teacher.spin')
spins += 1
const randomStarted = await waitForSpin((spin) => spin.wheel === 'main' && spin.phase === 'selection')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, randomStarted.spin.deadlineAt - Date.now() + 100)))
const randomLocked = await waitForSpin((spin) => spin.wheel === 'main' && spin.phase === 'decelerating')
if (randomLocked.spin.resultMode !== 'random' || !randomLocked.spin.resultId) throw new Error('An empty selection did not fall back to a random result.')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, randomLocked.spin.startedAt + randomLocked.spin.durationMs - Date.now() + 100)))
const randomStopped = await request.waitForState((next) => next.currentStage === 'stage2' && !next.spin)
if (randomStopped.currentRound.mainResultMode !== 'random') throw new Error('Random main-wheel mode was not recorded.')
for (const bet of randomStopped.currentRound.bets.filter((entry) => entry.teacherId === randomStopped.currentRound.actualTeacherId)) {
  await measuredCommand('round.bet.decision', { betId: bet.id, decision: 'risk' })
}
await measuredCommand('round.decisions.confirm')
await measuredCommand('risk.spin')
spins += 1
const randomRiskStarted = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'selection')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, randomRiskStarted.spin.deadlineAt - Date.now() + 100)))
const randomRiskLocked = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'decelerating')
if (randomRiskLocked.spin.resultMode !== 'random') throw new Error('An empty risk selection did not fall back to a random result.')
await new Promise((resolve) => setTimeout(resolve, Math.max(0, randomRiskLocked.spin.startedAt + randomRiskLocked.spin.durationMs - Date.now() + 100)))
await request.waitForState((next) => next.currentRound?.riskResultMode === 'random' && !next.spin)
await measuredCommand('risk.confirm')
const randomRiskCompleted = await request.waitForState((next) => next.currentRound?.status === 'completed')
if (![0, 3, 4].includes(randomRiskCompleted.currentRound.riskMultiplier)
  || randomRiskCompleted.currentRound.bets.some((bet) => bet.teacherId === randomRiskCompleted.currentRound.actualTeacherId
    && bet.payout !== bet.stake * randomRiskCompleted.currentRound.riskMultiplier)) {
  throw new Error('Random risk payout does not match its outcome and original stakes.')
}
await measuredCommand('round.next')
await addBets([{ teacherId: 'teacher-1', amount: 100 }])
await measuredCommand('round.start')
await measuredCommand('teacher.spin')
spins += 1
await measuredCommand('spin.select', { selection: 'teacher-1' })
await measuredCommand('teacher.confirm')
const collectStage = await request.waitForState((next) => next.currentStage === 'stage2' && !next.spin)
const collectBet = collectStage.currentRound.bets[0]
await measuredCommand('round.bet.decision', { betId: collectBet.id, decision: 'collect' })
await measuredCommand('round.decisions.confirm')
const collected = await request.waitForState((next) => next.currentRound?.status === 'completed')
if (collected.currentRound.finalPayout !== 200
  || collected.currentRound.bets[0].payout !== 200
  || collected.currentRound.stageTwoDecision !== 'collect') {
  throw new Error('Collecting did not finalize the configured 2X payout.')
}
await expectRejected('round.start', {})
const returnedToMain = await request.waitForState((next) => next.currentStage === 'waiting' && !next.currentRound)
if (!returnedToMain) throw new Error('The game did not return to the main page after displaying the final payout.')

await addBets([{ teacherId: 'teacher-1', amount: 100 }])
await measuredCommand('round.start')
await measuredCommand('teacher.spin')
spins += 1
await measuredCommand('spin.select', { selection: 'teacher-2' })
await measuredCommand('teacher.confirm')
await new Promise((resolve) => setTimeout(resolve, 2400))
const noWinnerRound = await request.waitForState((next) => next.currentStage === 'no-winners' && !next.spin)
if (noWinnerRound.currentRound.actualTeacherId !== 'teacher-2') throw new Error('No-winner round selected an unexpected teacher.')
if (noWinnerRound.audienceMessage !== 'NO WINNING BETS ON THIS TEACHER! No bets were placed on Mrs. Rai.') {
  throw new Error('Audience no-winner announcement is missing or incorrect.')
}
await expectRejected('risk.spin', {})
await measuredCommand('round.no-winners.confirm')
const noWinnerCompleted = await request.waitForState((next) => next.currentRound?.status === 'completed')
if (noWinnerCompleted.currentRound.finalPayout !== 0 || noWinnerCompleted.currentRound.stageTwoDecision !== 'no-winners') {
  throw new Error('No-winning-bets confirmation did not record a zero payout.')
}

await measuredCommand('round.next')
await addBets([{ teacherId: 'teacher-4', amount: 20 }])
await measuredCommand('round.start')
await measuredCommand('round.reset')
const cancelledRound = await request.waitForState((next) => next.currentRound?.status === 'cancelled')
if (cancelledRound.currentRound.finalPayout !== 0) throw new Error('Cancelling a round processed a payout.')
await request.waitForState((next) => next.currentStage === 'waiting' && !next.currentRound)

const runRiskOutcome = async (multiplier) => {
  await measuredCommand('round.next')
  await addBets([
    { teacherId: 'teacher-1', amount: 20 },
    { teacherId: 'teacher-1', amount: 100 },
  ])
  await measuredCommand('round.start')
  await measuredCommand('teacher.spin')
  spins += 1
  await measuredCommand('spin.select', { selection: 'teacher-1' })
  await measuredCommand('teacher.confirm')
  const stageTwo = await request.waitForState((next) => next.currentStage === 'stage2' && !next.spin)
  for (const bet of stageTwo.currentRound.bets) {
    await measuredCommand('round.bet.decision', { betId: bet.id, decision: 'risk' })
  }
  await measuredCommand('round.decisions.confirm')
  await measuredCommand('risk.spin')
  spins += 1
  await measuredCommand('spin.select', { selection: String(multiplier) })
  const started = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'selection')
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, started.spin.deadlineAt - Date.now() + 100)))
  const locked = await waitForSpin((spin) => spin.wheel === 'risk' && spin.phase === 'decelerating')
  if (Number(locked.spin.resultId) !== multiplier || locked.spin.resultMode !== 'operator-controlled') {
    throw new Error(`Risk wheel did not lock the selected ${multiplier}X outcome.`)
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, locked.spin.startedAt + locked.spin.durationMs - Date.now() + 100)))
  await request.waitForState((next) => next.currentRound?.riskMultiplier === multiplier && !next.spin)
  await measuredCommand('risk.confirm')
  const finalRound = await request.waitForState((next) => next.currentRound?.status === 'completed')
  if (finalRound.currentRound.finalPayout !== 120 * multiplier
    || finalRound.currentRound.bets.some((bet) => bet.payout !== bet.stake * multiplier)) {
    throw new Error(`${multiplier}X payout did not preserve each original stake.`)
  }
}

await runRiskOutcome(0)
await runRiskOutcome(4)

const beforeReconnect = performance.now()
socket.terminate()
socket = await connect()
request = listen(socket)
const finalRestore = await request('auth.restore', { token: login.token })
const recoveredState = finalRestore.state
const reconnectTimeMs = performance.now() - beforeReconnect
socket.close()
publicSocket.close()

const average = timings.reduce((sum, item) => sum + item, 0) / timings.length
const maximum = Math.max(...timings)
const completedRounds = recoveredState.history.length - initialHistory
const manualOverrides = recoveredState.auditLog.length - initialAuditCount
const expectedHistoryCount = 7
if (completedRounds !== expectedHistoryCount) throw new Error(`Expected ${expectedHistoryCount} test rounds; found ${completedRounds}.`)
if (manualOverrides !== 8) throw new Error(`Expected eight recorded operator selections; found ${manualOverrides}.`)
if ((recoveredState.currentRound && ['playerName', 'playerId'].some((field) => field in recoveredState.currentRound))
  || recoveredState.history.some((entry) => 'playerName' in entry || 'playerId' in entry)) {
  throw new Error('Legacy player identity data was returned in game state.')
}
const failedCommandIncrease = recoveredState.syncMetrics.failedCommands - initialFailedCommands
if (failedCommandIncrease < rejectedCommands) {
  throw new Error(`Server failure metrics increased by ${failedCommandIncrease}; expected at least ${rejectedCommands} rejected commands.`)
}

console.log(JSON.stringify({
  successfulCommands: timings.length,
  wheelSpins: spins,
  rejectedCommands,
  failedCommandIncrease,
  duplicatePayoutDeduplicated: true,
  publicBetAndSelectionPrivacyVerified: true,
  noWinnerConfirmationVerified: true,
  individualPayoutsVerified: true,
  riskOutcomesVerified: [0, 3, 4],
  pauseExtensionMs,
  adminDisconnectRecoveryMs: Number(adminDisconnectRecoveryMs.toFixed(2)),
  audienceDisconnectRecoveryMs: Number(audienceDisconnectRecoveryMs.toFixed(2)),
  completedRounds,
  auditedOperatorSelections: manualOverrides,
  randomFallbackVerified: randomLocked.spin.resultMode === 'random',
  averageAckRoundTripMs: Number(average.toFixed(2)),
  maximumAckRoundTripMs: Number(maximum.toFixed(2)),
  reconnectRecoveryMs: Number(reconnectTimeMs.toFixed(2)),
}, null, 2))
if (maximum >= 1000 || reconnectTimeMs >= 1000
  || adminDisconnectRecoveryMs >= 1000 || audienceDisconnectRecoveryMs >= 1000) process.exitCode = 1
