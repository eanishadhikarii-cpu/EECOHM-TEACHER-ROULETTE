export type StageName =
  | 'waiting'
  | 'teacher-spin'
  | 'stage2'
  | 'risk-spin'
  | 'final'

export type RiskMultiplier = 0 | 3 | 4

export interface Teacher {
  id: string
  name: string
  personality: string
  imageUrl: string
  color: string
  isActive: boolean
  position: number
}

export interface GameSettings {
  gameTitle: string
  eventName: string
  defaultStake: number
  minimumStake: number
  maximumStake: number
  soundEnabled: boolean
  confettiEnabled: boolean
  matchMultiplier: number
  riskMultipliers: RiskMultiplier[]
}

export interface ActiveRound {
  id: string
  actualTeacherId: string | null
  originalStake: number
  stageOneResult: 'pending' | 'selected'
  stageTwoDecision: 'collect' | 'risk' | null
  riskMultiplier: RiskMultiplier | null
  finalPayout: number
  status: 'in-progress' | 'completed' | 'cancelled'
  mainResultMode: 'random' | 'operator-controlled' | null
  riskResultMode: 'random' | 'operator-controlled' | null
  createdAt: string
}

export interface RoundHistoryEntry extends ActiveRound {
  completedAt: string
}

export interface AuditEntry {
  actionId: string
  action: 'teacher.spin' | 'risk.spin'
  actor: string
  outcome: string
  roundId: string
  at: string
}

export interface GameState {
  gameTitle: string
  eventName: string
  teachers: Teacher[]
  settings: GameSettings
  currentStage: StageName
  selectedTeacherId: string | null
  currentStake: number
  selectedTeacherRoll: string | null
  currentRound: ActiveRound | null
  history: RoundHistoryEntry[]
  auditLog: AuditEntry[]
  audienceMessage: string
  lastAction: string
  outerWheelRotation: number
  innerWheelRotation: number
  outerWheelStartRotation: number
  innerWheelStartRotation: number
  outerSpinSequence: number
  innerSpinSequence: number
  locked: boolean
  pausedWheel: 'main' | 'risk' | null
  revision: number
  serverTime: number
  syncMetrics: {
    commands: number
    failedCommands: number
    averageLatencyMs: number
    maxLatencyMs: number
    reconnects: number
    averageReconnectMs: number
    maxReconnectMs: number
  }
  spin?: {
    wheel: 'main' | 'risk'
    phase: 'selection' | 'decelerating'
    actionId: string
    startedAt: number
    durationMs: number
    deadlineAt: number
    selectedId: string | null
    selectionActionId: string | null
    resultId: string | null
    resultMode: 'random' | 'operator-controlled' | null
    fromRotation: number
    toRotation: number | null
    pausedAt?: number
  }
}
