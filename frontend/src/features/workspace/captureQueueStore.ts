/** Only capture UUIDs and consented payloads are persisted; acknowledged parts are deleted. */
export type CaptureFinalizePayload = {
  expected_batches: number; expected_video_chunks: number; ended_at_utc: string; duration_ms: number
  expected_tracking_video_chunks?: number; tracking_video_complete?: boolean
  game_started_at_ms?: number; game_ended_at_ms?: number; termination_reason?: string; known_data_gaps?: string[]
}
export type CaptureQueueState = {
  captureId: string; sequence: number; batches: number; chunks: number; trackingChunks?: number; frames: number; landmarks: number; videoBytes: number
  createdAt: string; knownDataGaps: string[]; stopped?: CaptureFinalizePayload
}
export type CaptureQueuePart = {
  key: string; captureId: string; sequence: number; kind: 'batch' | 'video' | 'tracking_video' | 'metadata'; path: string
  bytes: number; body?: unknown; blob?: Blob
}
export type CaptureQueueLimits = { maxBytes: number; maxParts: number }
export interface CaptureQueueStore {
  getState(id: string): Promise<CaptureQueueState | undefined>
  listStates(): Promise<CaptureQueueState[]>
  saveState(state: CaptureQueueState): Promise<void>
  markIncomplete(id: string, reason: string): Promise<void>
  putPart(part: CaptureQueuePart, state: CaptureQueueState, limits: CaptureQueueLimits): Promise<void>
  firstPart(id: string): Promise<CaptureQueuePart | undefined>
  acknowledge(key: string): Promise<void>
  removeState(id: string): Promise<void>
}
const full = () => new Error('Hàng đợi nghiên cứu đã đầy; dữ liệu chưa đầy đủ. Phần chưa được xác nhận vẫn được giữ.')

/** Compatibility store for existing manual/replay capture; clinical auto capture requires IndexedDB. */
export class MemoryCaptureQueueStore implements CaptureQueueStore {
  private states = new Map<string, CaptureQueueState>()
  private parts = new Map<string, CaptureQueuePart>()
  async getState(id: string) { return this.states.get(id) }
  async listStates() { return [...this.states.values()] }
  async saveState(state: CaptureQueueState) { this.states.set(state.captureId, state) }
  async markIncomplete(id: string, reason: string) {
    const state = this.states.get(id)
    if (state) this.states.set(id, { ...state, knownDataGaps: [...new Set([...state.knownDataGaps, reason])].slice(0, 32) })
  }
  async putPart(part: CaptureQueuePart, state: CaptureQueueState, limits: CaptureQueueLimits) {
    const bytes = [...this.parts.values()].reduce((sum, item) => sum + item.bytes, 0)
    if (!this.parts.has(part.key) && (bytes + part.bytes > limits.maxBytes || this.parts.size >= limits.maxParts)) throw full()
    this.parts.set(part.key, part); this.states.set(state.captureId, state)
  }
  async firstPart(id: string) { return [...this.parts.values()].filter(part => part.captureId === id).sort((a, b) => a.sequence - b.sequence)[0] }
  async acknowledge(key: string) { this.parts.delete(key) }
  async removeState(id: string) { this.states.delete(id) }
}

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('Không đọc được hàng đợi nghiên cứu.'))
})
const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Không ghi được hàng đợi nghiên cứu.'))
})

export class IndexedDbCaptureQueueStore implements CaptureQueueStore {
  private database: Promise<IDBDatabase> | null = null
  private open() {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB không khả dụng; không thể thu nghiên cứu bền vững.')); return }
      const request = indexedDB.open('rehab-research-capture', 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('captures', { keyPath: 'captureId' })
        const parts = db.createObjectStore('parts', { keyPath: 'key' })
        parts.createIndex('captureSequence', ['captureId', 'sequence'], { unique: true })
        db.createObjectStore('usage')
      }
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); this.database = null }; resolve(db) }
      request.onerror = () => { this.database = null; reject(request.error || new Error('Không mở được hàng đợi nghiên cứu.')) }
      request.onblocked = () => { this.database = null; reject(new Error('IndexedDB đang bị tab khác khóa.')) }
    })
    return this.database
  }
  async getState(id: string) { const db = await this.open(); return requestResult<CaptureQueueState | undefined>(db.transaction('captures').objectStore('captures').get(id)) }
  async listStates() { const db = await this.open(); return requestResult<CaptureQueueState[]>(db.transaction('captures').objectStore('captures').getAll()) }
  async saveState(state: CaptureQueueState) {
    const db = await this.open(), tx = db.transaction('captures', 'readwrite'), done = transactionDone(tx)
    tx.objectStore('captures').put(state); await done
  }
  async markIncomplete(id: string, reason: string) {
    const db = await this.open(), tx = db.transaction('captures', 'readwrite'), done = transactionDone(tx)
    const store = tx.objectStore('captures'), request = store.get(id)
    request.onsuccess = () => {
      const state = request.result as CaptureQueueState | undefined
      if (state) store.put({ ...state, knownDataGaps: [...new Set([...state.knownDataGaps, reason])].slice(0, 32) })
    }
    await done
  }
  async putPart(part: CaptureQueuePart, state: CaptureQueueState, limits: CaptureQueueLimits) {
    const db = await this.open(), tx = db.transaction(['captures', 'parts', 'usage'], 'readwrite')
    let capacityError: Error | null = null
    const done = transactionDone(tx), usageStore = tx.objectStore('usage')
    const usageRequest = usageStore.get('total')
    usageRequest.onsuccess = () => {
      const usage = (usageRequest.result || { bytes: 0, parts: 0 }) as { bytes: number; parts: number }
      if (usage.bytes + part.bytes > limits.maxBytes || usage.parts + 1 > limits.maxParts) { capacityError = full(); tx.abort(); return }
      tx.objectStore('parts').add(part)
      tx.objectStore('captures').put(state)
      usageStore.put({ bytes: usage.bytes + part.bytes, parts: usage.parts + 1 }, 'total')
    }
    try { await done } catch (error) { throw capacityError || error }
  }
  async firstPart(id: string) {
    const db = await this.open(), tx = db.transaction('parts')
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
    const cursor = await requestResult(tx.objectStore('parts').index('captureSequence').openCursor(range))
    return cursor?.value as CaptureQueuePart | undefined
  }
  async acknowledge(key: string) {
    const db = await this.open(), tx = db.transaction(['parts', 'usage'], 'readwrite'), done = transactionDone(tx)
    const parts = tx.objectStore('parts'), usageStore = tx.objectStore('usage'), partRequest = parts.get(key)
    partRequest.onsuccess = () => {
      const part = partRequest.result as CaptureQueuePart | undefined
      if (!part) return
      const usageRequest = usageStore.get('total')
      usageRequest.onsuccess = () => {
        const usage = (usageRequest.result || { bytes: part.bytes, parts: 1 }) as { bytes: number; parts: number }
        parts.delete(key); usageStore.put({ bytes: Math.max(0, usage.bytes - part.bytes), parts: Math.max(0, usage.parts - 1) }, 'total')
      }
    }
    await done
  }
  async removeState(id: string) {
    const db = await this.open(), tx = db.transaction('captures', 'readwrite'), done = transactionDone(tx)
    tx.objectStore('captures').delete(id); await done
  }
}

export const durableCaptureQueue = new IndexedDbCaptureQueueStore()
