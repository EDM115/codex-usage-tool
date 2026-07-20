export type ProgressState = "success" | "failure" | "neutral"

export type ProgressStep = {
  weight: number
}

export type ProgressSink = {
  setSteps(steps: ProgressStep[]): void
  step(message: string, state?: ProgressState): void
  status(message: string): void
  statusProgress(message: string, completed: number, total: number): void
  statusDone(message: string, state?: ProgressState): void
  finish(): void
}

export class CliProgress implements ProgressSink {
  private steps: ProgressStep[] = [{ weight: 1 }]
  private totalWeight = 1
  private completedWeight = 0
  private currentStep = 0
  private stageProgress = 0
  private statusLine = ""
  private renderedLines = 0

  constructor(private readonly options: { silent: boolean }) {}

  setSteps(steps: ProgressStep[]): void {
    this.steps = steps.length > 0 ? steps.map(normalizeStep) : [{ weight: 1 }]
    this.totalWeight = this.steps.reduce((sum, step) => sum + step.weight, 0)
    this.completedWeight = 0
    this.currentStep = 0
    this.stageProgress = 0
    this.render()
  }

  step(message: string, state: ProgressState = "success"): void {
    this.statusLine = ""
    this.stageProgress = 0
    this.completedWeight = Math.min(
      this.totalWeight,
      this.completedWeight + (this.steps[this.currentStep]?.weight ?? 0),
    )
    this.currentStep += 1

    if (!this.options.silent) {
      this.writeMarkedLine(message, state)
    }

    this.render()
  }

  statusProgress(message: string, completed: number, total: number): void {
    this.statusLine = message
    this.stageProgress = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0
    this.render()
  }

  status(message: string): void {
    if (this.options.silent) {
      return
    }

    this.statusLine = message
    this.render()
  }

  statusDone(message: string, state: ProgressState = "success"): void {
    this.statusLine = ""
    this.step(message, state)
  }

  finish(): void {
    if (this.renderedLines === 0) {
      this.render()
    }

    process.stderr.write("\n")
    this.renderedLines = 0
  }

  private writeMarkedLine(message: string, state: ProgressState): void {
    this.clearRendered()
    process.stderr.write(`${markFor(state)} ${message}\n`)
  }

  private render(): void {
    this.clearRendered()
    const currentWeight = this.steps[this.currentStep]?.weight ?? 0
    const completed = Math.min(
      this.totalWeight,
      this.completedWeight + currentWeight * this.stageProgress,
    )
    const percent = Math.round((completed / this.totalWeight) * 100)
    const width = 24
    const filled = Math.max(0, Math.min(width, Math.round((completed / this.totalWeight) * width)))
    const bar = `${"▰".repeat(filled)}${"▱".repeat(width - filled)}`

    if (!this.options.silent && this.statusLine) {
      process.stderr.write(`${this.statusLine}\n`)
    }

    process.stderr.write(`[${bar}] ${String(percent).padStart(3, " ")}%`)
    this.renderedLines = !this.options.silent && this.statusLine ? 2 : 1
  }

  private clearRendered(): void {
    if (this.renderedLines === 0) {
      return
    }

    for (let index = 0; index < this.renderedLines; index += 1) {
      process.stderr.write("\r\x1b[K")

      if (index < this.renderedLines - 1) {
        process.stderr.write("\x1b[1A")
      }
    }

    this.renderedLines = 0
  }
}

function normalizeStep(step: ProgressStep): ProgressStep {
  return { weight: Math.max(0, Number.isFinite(step.weight) ? step.weight : 0) }
}

function markFor(state: ProgressState): string {
  if (state === "failure") {
    return "✗"
  }

  if (state === "neutral") {
    return "•"
  }

  return "✓"
}

export const noopProgress: ProgressSink = {
  setSteps() {},
  step() {},
  status() {},
  statusProgress() {},
  statusDone() {},
  finish() {},
}
