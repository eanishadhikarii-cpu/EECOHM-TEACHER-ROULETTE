import type { RiskMultiplier, Teacher } from './types'

export function createRoundId(): string {
  return `round-${Math.random().toString(36).slice(2, 10)}`
}

export function getTeacherById(teachers: Teacher[], teacherId: string | null): Teacher | undefined {
  return teachers.find((teacher) => teacher.id === teacherId)
}

export function getRandomRisk(): RiskMultiplier {
  const choices: RiskMultiplier[] = [0, 3, 4]
  const index = Math.floor(Math.random() * choices.length)
  return choices[index]
}

export function getRandomTeacher(teachers: Teacher[], includeInactive = false): Teacher {
  const activeTeachers = includeInactive ? teachers : teachers.filter((teacher) => teacher.isActive)
  const pick = activeTeachers[Math.floor(Math.random() * activeTeachers.length)]
  return pick ?? teachers[0]
}

export function calculateMultiplierFromRisk(risk: RiskMultiplier | null): number {
  if (risk === 0) return 0
  if (risk === 3) return 3
  if (risk === 4) return 4
  return 0
}

export function formatStake(value: number): string {
  return `${value.toLocaleString()} pts`
}

export function getWheelTargetRotation(index: number, total: number): number {
  const segmentSize = 360 / total
  const centerOffset = segmentSize / 2
  return 360 * 7 + (360 - (index * segmentSize + centerOffset + 90)) % 360
}

export function getRiskLabel(risk: RiskMultiplier | null): string {
  if (risk === 0) return '0X'
  if (risk === 3) return '3X'
  if (risk === 4) return '4X'
  return '—'
}
