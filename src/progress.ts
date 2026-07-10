export type ProgressState = "success" | "failure" | "neutral"

export type ProgressSink = {
  setTotal(total: number): void
  step(message: string, state?: ProgressState): void
  status(message: string): void
  statusDone(message: string, state?: ProgressState): void
  finish(): void
}

export class CliProgress implements ProgressSink {
  private total = 1
  private current = 0
  private statusLine = ""
  private renderedLines = 0

  constructor(private readonly options: { silent: boolean }) {}

  setTotal(total: number): void {
    this.total = Math.max(1, total)
    this.current = 0
    this.render()
  }

  step(message: string, state: ProgressState = "success"): void {
    this.statusLine = ""
    this.current = Math.min(this.total, this.current + 1)

    if (!this.options.silent) {
      this.writeMarkedLine(message, state)
    }

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
    const percent = Math.round((this.current / this.total) * 100)
    const width = 24
    const filled = Math.max(0, Math.min(width, Math.round((this.current / this.total) * width)))
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`

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
  setTotal() {},
  step() {},
  status() {},
  statusDone() {},
  finish() {},
}
