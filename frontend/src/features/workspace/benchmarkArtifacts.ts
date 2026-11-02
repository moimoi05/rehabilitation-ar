export const BENCHMARK_API = `${import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8001'}/api/benchmarks`

export async function benchmarkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BENCHMARK_API}${path}`, init)
  if (!response.ok) throw new Error(`${response.status} ${path}: ${await response.text()}`)
  return response.json() as Promise<T>
}

/** Bounded asynchronous uploads: fail the run, never silently drop recording/data. */
export class BenchmarkArtifacts {
  private tail = Promise.resolve()
  private queued = 0
  private offsets = new Map<string, number>()
  private failure: Error | null = null
  constructor(readonly runId: string, private onError: (error: Error) => void) {}

  append(name: string, content: Blob | string): void {
    if (this.failure) return
    const blob = typeof content === 'string' ? new Blob([content]) : content
    this.queued += blob.size
    if (this.queued > 32 * 1024 * 1024) {
      this.fail(new Error('Artifact upload backlog exceeded 32 MiB; run stopped without dropping data.'))
      return
    }
    this.tail = this.tail.then(async () => {
      for (let start = 0; start < blob.size; start += 4 * 1024 * 1024) {
        const chunk = blob.slice(start, start + 4 * 1024 * 1024)
        const offset = this.offsets.get(name) ?? 0
        const result = await benchmarkRequest<{ size: number }>(`/runs/${this.runId}/artifacts/${name}?offset=${offset}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk,
        })
        if (result.size !== offset + chunk.size) throw new Error(`Unexpected saved size for ${name}`)
        this.offsets.set(name, result.size)
      }
      this.queued -= blob.size
    }).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
  }

  private fail(error: Error): void { if (!this.failure) { this.failure = error; this.onError(error) } }
  async flush(): Promise<void> { await this.tail; if (this.failure) throw this.failure }
}

export function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
  return { mean_ms: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, p50_ms: percentile(.5), p95_ms: percentile(.95), samples: values.length }
}
