import { expect, test } from "bun:test"

import { CliProgress } from "../src/progress"

test("renders item progress within the weighted current stage", () => {
  const writes: string[] = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))

    return true
  }) as typeof process.stderr.write

  try {
    const progress = new CliProgress({ silent: true })
    progress.setSteps([{ weight: 2 }, { weight: 8 }, { weight: 1 }])
    progress.step("Completed setup")

    progress.statusProgress("Processing source 1/4", 1, 4)
    expect(lastRenderedPercent(writes)).toBe(36)

    progress.statusProgress("Processing source 4/4", 4, 4)
    expect(lastRenderedPercent(writes)).toBe(91)
  } finally {
    process.stderr.write = originalWrite
  }
})

function lastRenderedPercent(writes: string[]): number {
  const matches = [...writes.join("").matchAll(/\]\s+(\d+)%/g)]

  return Number(matches.at(-1)?.[1])
}
