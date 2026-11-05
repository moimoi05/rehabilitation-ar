import type { Point, Side } from './drawing'
import type { Size, VideoMapping } from './videoGeometry'
import { AffectedHandSelector, DRAWING_POLICY, indexPointing } from './freeDrawingHand'
import type { DrawingObservation, HandSelectionReason } from './freeDrawingHand'
import { drawingViewport, mapDrawingPoint } from './freeDrawingRenderer'
import type { GameResearchSink, ResearchContext } from './gameResearch'

export type { DrawingObservation } from './freeDrawingHand'
export type DrawingMode = 'gesture' | 'assisted'
export type DrawingInteractionMode = 'draw' | 'move'
export type DrawingPhase = 'ready' | 'drawing' | 'dragging' | 'tracking_lost' | 'paused' | 'finished'
export type DrawingRejectionReason = HandSelectionReason | 'STALE_HAND' | 'GESTURE_INACTIVE' | 'DRAWING_PAUSED' |
  'CURSOR_OUTSIDE_BOARD' | 'CURSOR_JUMP' | 'PEN_UP' | 'DRAWING_LIMIT' | 'GEOMETRY_CHANGED' | 'EXERCISE_FINISHED'
export type DrawingPoint = { x: number; y: number; timestamp: number; frameId?: number }
export type DrawingStroke = {
  id: number; color: string; width: number; mode: DrawingMode
  points: DrawingPoint[]; startedAt: number; endedAt: number | null
  offset?: { x: number; y: number }
}
export type DrawingSegment = { stroke: DrawingStroke; from: DrawingPoint | null; to: DrawingPoint }
export type DrawingUpdate = {
  phase: DrawingPhase; cursor: { x: number; y: number } | null; hand: Point[] | null; segment: DrawingSegment | null
  artworkChanged: boolean
}
export type DrawingOptions = { mode: DrawingMode; interactionMode: DrawingInteractionMode; cursorSource: 'index' | 'wrist'; color: string; width: number }
type Options = Partial<Pick<DrawingOptions, 'color' | 'width' | 'interactionMode'>> & Pick<DrawingOptions, 'mode' | 'cursorSource'> & { side: Side; logicalSize?: Size; research?: GameResearchSink }
type Cursor = { x: number; y: number }
type Grab = { id: string; stroke: DrawingStroke; anchor: Cursor; last: Cursor; bounds: { left: number; right: number; top: number; bottom: number } }
type UndoOperation = { type: 'add'; id: number } | { type: 'move'; id: number; offset: Cursor }

/** Closest polyline wins, newest wins ties. Tolerance is specified in CSS pixels. */
export function hitTestStroke(strokes: readonly DrawingStroke[], cursor: Cursor, tolerancePx = 22, displayScale = 1): DrawingStroke | null {
  if (![cursor.x, cursor.y, tolerancePx, displayScale].every(Number.isFinite) || displayScale <= 0) return null
  let closest: DrawingStroke | null = null, closestDistance = Infinity
  for (const stroke of strokes) {
    const offset = stroke.offset ?? { x: 0, y: 0 }
    const x = cursor.x - offset.x, y = cursor.y - offset.y
    for (let index = 0; index < stroke.points.length; index += 1) {
      const a = stroke.points[index], b = stroke.points[Math.max(0, index - 1)]
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
      const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0
      const distance = Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
      if (distance <= tolerancePx / displayScale + stroke.width / 2 && distance <= closestDistance) {
        closest = stroke; closestDistance = distance
      }
    }
  }
  return closest
}

/** High-frequency input stays outside React. Raw observations are never modified. */
export class DrawingController {
  readonly logicalSize: Size
  phase: DrawingPhase = 'tracking_lost'
  cursor: Cursor | null = null
  hand: Point[] | null = null
  penDown = false
  limitReached = false
  draggingInterrupted = false
  metrics = { acceptedUpdates: 0, trackingLosses: 0, skippedObservations: 0, staleObservations: 0 }
  private options: DrawingOptions
  private selector: AffectedHandSelector
  private artwork: DrawingStroke[] = []
  private history: UndoOperation[] = []
  private active: DrawingStroke | null = null
  private lastTimestamp = 0
  private lastFrameId: number | undefined
  private geometry = ''
  private pointingFrames = 0
  private awaitingFreshHand = false
  private pointCount = 0
  private sequence = 0
  private paused = false
  private rejectionReason: DrawingRejectionReason | null = 'ACQUIRING'
  private gestureActive: boolean | null = null
  private grab: Grab | null = null
  private hoveredId: number | null = null
  private displayScale = 1
  private readonly research?: GameResearchSink
  private researchContext: ResearchContext = { timestamp: 0 }
  private researchPenDown = false
  private trackingUsable = false
  private dragSequence = 0
  private researchFailed = false

  constructor(options: Options) {
    this.options = { color: '#f472b6', width: 5, interactionMode: 'draw', ...options }
    this.logicalSize = options.logicalSize ?? { width: 1000, height: 562.5 }
    this.selector = new AffectedHandSelector(options.side)
    this.research = options.research
  }
  get strokes(): readonly DrawingStroke[] { return this.artwork }
  get selectedStrokeId(): number | null { return this.grab?.stroke.id ?? this.hoveredId }
  get grabbedStrokeIds(): readonly number[] { return this.grab ? [this.grab.stroke.id] : [] }
  get completedStrokeCount() { return this.artwork.filter(stroke => stroke.endedAt !== null).length }
  get activeDrawingMs() { return this.artwork.reduce((sum, stroke) => sum + Math.max(0, (stroke.points.at(-1)?.timestamp ?? stroke.startedAt) - stroke.startedAt), 0) }
  get diagnostics() {
    return { reason: this.rejectionReason, selected: this.hand !== null, armed: this.options.mode === 'gesture' ? this.pointingFrames >= DRAWING_POLICY.gestureFrames : this.penDown,
      gestureActive: this.gestureActive, penDown: this.penDown || this.phase === 'drawing', observationTimestamp: this.lastTimestamp }
  }

  private result(segment: DrawingSegment | null = null, artworkChanged = false): DrawingUpdate {
    return { phase: this.phase, cursor: this.cursor, hand: this.hand, segment, artworkChanged }
  }
  private remember(operation: UndoOperation) { this.history = [...this.history.slice(-999), operation] }
  private interaction(type: string, payload: Record<string, unknown>, sample = false) {
    if (!this.research || this.researchFailed) return
    try { this.research[sample ? 'sample' : 'event'](type, payload, sample ? { ...this.researchContext, timestamp: this.researchContext.sourceTimestamp ?? this.researchContext.timestamp } : this.researchContext) }
    catch (error) { this.researchFailed = true; console.warn('Drawing research recording unavailable', error) }
  }
  private interactionCoordinates() {
    return { coordinate_space: 'logical_canvas_px', width: this.logicalSize.width, height: this.logicalSize.height,
      drawing_mode: this.options.mode, cursor_source: this.options.interactionMode === 'draw' && this.options.mode === 'gesture' ? 'index' : this.options.cursorSource,
      representation: 'game_processed', usable: true, freshness: 'fresh', mapping_version: 'drawing-contain-v1' }
  }
  private track(usable: boolean, reason?: string) {
    if (this.trackingUsable === usable) return
    this.trackingUsable = usable
    this.interaction(usable ? 'TRACKING_RECOVERED' : 'TRACKING_LOST', { reason: reason ?? null })
  }
  private pen(down: boolean, reason: string) {
    if (this.researchPenDown === down) return
    this.researchPenDown = down
    this.interaction(down ? 'PEN_DOWN' : 'PEN_UP', { reason, drawing_mode: this.options.mode })
  }
  private dropGrab(interrupted = false, reason = 'user_action') {
    if (this.grab) {
      const before = this.grab.stroke.offset ?? { x: 0, y: 0 }
      const after = this.artwork.find(stroke => stroke.id === this.grab!.stroke.id)?.offset ?? { x: 0, y: 0 }
      if (before.x !== after.x || before.y !== after.y) this.remember({ type: 'move', id: this.grab.stroke.id, offset: { ...before } })
      this.draggingInterrupted = interrupted
      const payload = { drag_id: this.grab.id, stroke_id: this.grab.stroke.id, reason, interrupted, offset_x: after.x, offset_y: after.y,
        x: this.grab.last.x, y: this.grab.last.y }
      this.interaction(interrupted ? 'DRAG_INTERRUPTED' : 'STROKE_RELEASED', payload)
    }
    this.grab = null
    if (this.phase === 'dragging') this.phase = 'ready'
  }
  private endStroke(reason = 'unknown', interrupted = false) {
    this.awaitingFreshHand = false
    if (this.active) {
      this.active.endedAt = this.active.points.at(-1)?.timestamp ?? this.active.startedAt
      this.interaction('STROKE_COMPLETED', { stroke_id: this.active.id, reason, interrupted, point_count: this.active.points.length })
    }
    this.pen(false, reason)
    this.active = null
    if (this.phase === 'drawing') this.phase = 'ready'
  }
  private lose(reason: DrawingRejectionReason = 'ACQUIRING', preserveContinuity = false) {
    const cause = reason === 'GEOMETRY_CHANGED' ? 'geometry_changed' : this.paused ? 'user_action' : 'tracking_lost'
    if (!this.paused && reason !== 'GEOMETRY_CHANGED') this.track(false, reason)
    else this.trackingUsable = false
    if (this.phase === 'ready' || this.phase === 'drawing' || this.phase === 'dragging') this.metrics.trackingLosses += 1
    this.dropGrab(true, cause); this.hoveredId = null
    this.endStroke(cause, true); this.penDown = false
    if (!preserveContinuity) { this.pointingFrames = 0; this.selector.lose() }
    this.cursor = null; this.hand = null
    this.phase = this.paused ? 'paused' : 'tracking_lost'
    this.gestureActive = null; this.rejectionReason = this.paused ? 'DRAWING_PAUSED' : reason
  }
  private canWaitForFreshHand(now: number) {
    const lastPoint = this.active?.points.at(-1)
    return this.options.mode === 'gesture' && this.options.interactionMode === 'draw' && !!lastPoint &&
      now >= lastPoint.timestamp && now - lastPoint.timestamp <= DRAWING_POLICY.continuityGraceMs
  }
  private waitForFreshHand(reason: DrawingRejectionReason) {
    // Keep the stroke open briefly, but never draw, display or reuse a stale point.
    this.track(false, reason)
    this.awaitingFreshHand = true; this.cursor = null; this.hand = null
    this.phase = 'tracking_lost'; this.gestureActive = null; this.rejectionReason = reason
  }

  private liftForCursor(reason: DrawingRejectionReason) {
    const cause = reason === 'CURSOR_JUMP' ? 'cursor_jump' : 'cursor_outside_board'
    this.dropGrab(true, cause); this.hoveredId = null
    this.endStroke(cause, true); this.penDown = false; this.pointingFrames = 0
    this.phase = 'ready'; this.rejectionReason = reason
  }

  configure(options: Partial<DrawingOptions>, now = performance.now()) {
    this.researchContext = { timestamp: now }
    this.dropGrab(false, 'mode_changed'); this.hoveredId = null
    this.endStroke('mode_changed'); this.penDown = false; this.pointingFrames = 0
    const before = this.options
    this.options = { ...this.options, ...options }
    if (Object.keys(options).some(key => before[key as keyof DrawingOptions] !== this.options[key as keyof DrawingOptions])) this.interaction('TOOL_CHANGED', { previous: before, current: this.options })
    if (this.phase === 'finished') return
    this.gestureActive = null; this.rejectionReason = this.options.mode === 'gesture' ? 'GESTURE_INACTIVE' : 'PEN_UP'
  }
  setPenDown(down: boolean, now = performance.now()) {
    this.researchContext = { timestamp: now }
    if (this.phase === 'finished' || this.options.interactionMode !== 'draw') return
    if (!down) { this.endStroke('user_action'); this.penDown = false; this.rejectionReason = 'PEN_UP'; return }
    if (this.phase === 'ready' && this.cursor && !this.limitReached) { this.penDown = true; this.pen(true, 'user_action'); this.rejectionReason = null }
  }
  grabStroke(now = performance.now()): boolean {
    this.researchContext = { timestamp: now }
    if (this.options.interactionMode !== 'move' || this.paused || this.phase === 'finished') return false
    // Demo pointer positions remain valid while stationary; Hand input must expire.
    if (this.hand) this.checkFreshness(now)
    if (this.phase !== 'ready' || !this.cursor || this.hoveredId === null || !Number.isFinite(now) || now < this.lastTimestamp) return false
    const stroke = this.artwork.find(candidate => candidate.id === this.hoveredId && candidate.endedAt !== null)
    if (!stroke) return false
    const bounds = stroke.points.reduce((box, point) => ({ left: Math.min(box.left, point.x), right: Math.max(box.right, point.x), top: Math.min(box.top, point.y), bottom: Math.max(box.bottom, point.y) }),
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })
    this.grab = { id: `drag-${++this.dragSequence}`, stroke, anchor: { ...this.cursor }, last: { ...this.cursor }, bounds }
    this.interaction('STROKE_GRABBED', { drag_id: this.grab.id, stroke_id: stroke.id, x: this.cursor.x, y: this.cursor.y, offset_x: stroke.offset?.x ?? 0, offset_y: stroke.offset?.y ?? 0, ...this.interactionCoordinates() })
    this.draggingInterrupted = false; this.phase = 'dragging'; this.penDown = false; this.rejectionReason = null
    return true
  }
  releaseStroke(now = performance.now()) { this.researchContext = { timestamp: now }; this.dropGrab() }
  checkFreshness(now: number): DrawingUpdate {
    this.researchContext = { timestamp: now }
    // Expire all usable landmarks immediately. Keep only identity/gesture evidence
    // between consecutive source frames; update() resets it on a real >150ms gap.
    if (this.awaitingFreshHand && !this.canWaitForFreshHand(now)) this.lose('STALE_HAND')
    else if (this.phase !== 'finished' && this.lastTimestamp > 0 && now - this.lastTimestamp > DRAWING_POLICY.maxAgeMs) {
      if (this.canWaitForFreshHand(now)) this.waitForFreshHand('STALE_HAND')
      else this.lose('STALE_HAND', true)
    }
    return this.result()
  }
  suspend(now = performance.now()) {
    this.researchContext = { timestamp: now }
    if (this.phase !== 'finished') { if (!this.paused) this.interaction('GAME_PAUSED', { reason: 'user_action' }); this.paused = true; this.lose() }
  }
  resume(now = performance.now()) {
    this.researchContext = { timestamp: now }
    if (this.phase === 'paused') { this.paused = false; this.phase = 'tracking_lost'; this.rejectionReason = 'ACQUIRING'; this.interaction('GAME_RESUMED', { tracking_usable: false }) }
  }
  finish(now = performance.now(), reason = 'exercise_finished', interrupted = false) {
    this.researchContext = { timestamp: now }
    this.dropGrab(interrupted, reason); this.hoveredId = null; this.endStroke(reason, interrupted); this.penDown = false; this.cursor = null; this.hand = null; this.gestureActive = null; this.phase = 'finished'; this.rejectionReason = 'EXERCISE_FINISHED'
  }
  reset() {
    this.dropGrab(); this.artwork = []; this.history = []; this.active = null; this.pointCount = 0; this.sequence = 0
    this.lastTimestamp = 0; this.lastFrameId = undefined; this.geometry = ''; this.pointingFrames = 0
    this.paused = false; this.limitReached = false; this.penDown = false; this.draggingInterrupted = false; this.hoveredId = null
    this.cursor = null; this.hand = null; this.selector.reset(); this.phase = 'tracking_lost'
    this.gestureActive = null; this.rejectionReason = 'ACQUIRING'
    this.metrics = { acceptedUpdates: 0, trackingLosses: 0, skippedObservations: 0, staleObservations: 0 }
    this.researchPenDown = false; this.trackingUsable = false; this.dragSequence = 0
  }
  resetInput(now = performance.now(), reason: 'tracking_lost' | 'geometry_changed' = 'geometry_changed', snapshot?: Record<string, unknown>) {
    if (this.phase === 'finished') return
    this.researchContext = { timestamp: now }
    if (reason === 'geometry_changed') this.interaction('GEOMETRY_CHANGED', { reason, ...this.interactionCoordinates(), ...snapshot })
    this.lose(reason === 'geometry_changed' ? 'GEOMETRY_CHANGED' : 'RAW_HAND_MISSING')
    this.selector.reset(); this.lastTimestamp = 0; this.lastFrameId = undefined; this.geometry = ''
  }
  undo(now = performance.now()) {
    this.researchContext = { timestamp: now }
    this.dropGrab(); this.hoveredId = null
    this.endStroke('user_action'); this.penDown = false; this.pointingFrames = 0
    if (this.hand && this.phase !== 'finished') this.rejectionReason = this.options.mode === 'gesture' ? 'GESTURE_INACTIVE' : 'PEN_UP'
    const operation = this.history.at(-1)
    this.interaction('UNDO', { operation: operation?.type ?? null, stroke_id: operation?.id ?? null, previous_offset: operation?.type === 'move' ? operation.offset : null })
    this.history = this.history.slice(0, -1)
    if (operation?.type === 'move') this.artwork = this.artwork.map(stroke => stroke.id === operation.id ? { ...stroke, offset: { ...operation.offset } } : stroke)
    if (operation?.type === 'add') {
      this.pointCount -= this.artwork.find(stroke => stroke.id === operation.id)?.points.length ?? 0
      this.artwork = this.artwork.filter(stroke => stroke.id !== operation.id)
    }
    this.limitReached = false
  }
  clear(now = performance.now()) {
    this.researchContext = { timestamp: now }
    this.dropGrab(); this.hoveredId = null
    this.endStroke('user_action'); this.penDown = false; this.pointingFrames = 0
    if (this.hand && this.phase !== 'finished') this.rejectionReason = this.options.mode === 'gesture' ? 'GESTURE_INACTIVE' : 'PEN_UP'
    this.interaction('CLEAR_CANVAS', { stroke_ids: this.artwork.map(stroke => stroke.id) })
    this.artwork = []; this.history = []; this.pointCount = 0; this.limitReached = false
  }

  update(observation: DrawingObservation, now: number, mapping: VideoMapping, mirrored: boolean): DrawingUpdate {
    if (this.phase === 'finished' || this.paused) return this.result()
    this.researchContext = { timestamp: now, sourceTimestamp: observation.timestamp, sourceObservationId: observation.sourceObservationId ?? null }
    if (!Number.isFinite(now) || !Number.isFinite(observation.timestamp) || observation.timestamp <= 0 || now < observation.timestamp || now - observation.timestamp > DRAWING_POLICY.maxAgeMs) {
      this.metrics.staleObservations += 1; this.lose('STALE_HAND'); return this.result()
    }
    if (observation.timestamp <= this.lastTimestamp || (observation.frameId !== undefined && observation.frameId === this.lastFrameId)) {
      this.metrics.skippedObservations += 1; return this.checkFreshness(now)
    }
    const gap = this.lastTimestamp > 0 && observation.timestamp - this.lastTimestamp > DRAWING_POLICY.maxAgeMs
    this.lastTimestamp = observation.timestamp; this.lastFrameId = observation.frameId
    const geometry = [mapping.box.width, mapping.box.height, mapping.rect.x, mapping.rect.y, mapping.rect.width, mapping.rect.height, mirrored].join('|')
    if (this.geometry && geometry !== this.geometry) {
      this.interaction('GEOMETRY_CHANGED', { mapping, mirrored, ...this.interactionCoordinates() })
      this.geometry = geometry; this.lose('GEOMETRY_CHANGED'); return this.result()
    }
    if (this.awaitingFreshHand && !this.canWaitForFreshHand(now)) this.lose('STALE_HAND')
    if (gap) {
      if (this.canWaitForFreshHand(now)) this.waitForFreshHand('STALE_HAND')
      else this.lose('STALE_HAND')
    }
    this.geometry = geometry
    this.displayScale = drawingViewport(this.logicalSize, mapping.box).width / this.logicalSize.width
    if (!observation.hands.length && this.canWaitForFreshHand(now)) {
      this.waitForFreshHand('RAW_HAND_MISSING'); return this.result()
    }
    if (this.awaitingFreshHand && !this.selector.matchesPrevious(observation)) this.lose('SIDE_AMBIGUOUS')
    this.awaitingFreshHand = false
    const selected = this.selector.select(observation)
    if (!selected) {
      // Acquisition frames must accumulate; only actual invalidity resets the selector.
      if (this.phase === 'ready' || this.phase === 'drawing' || this.phase === 'dragging') this.metrics.trackingLosses += 1
      this.track(false, this.selector.rejectionReason ?? undefined)
      this.dropGrab(true, 'tracking_lost'); this.hoveredId = null
      this.endStroke('tracking_lost', true); this.penDown = false; this.cursor = null; this.hand = null
      this.pointingFrames = 0; this.phase = 'tracking_lost'
      this.gestureActive = null; this.rejectionReason = this.selector.rejectionReason
      return this.result()
    }
    const rawCursor = selected[this.options.interactionMode === 'draw' && this.options.mode === 'gesture' || this.options.cursorSource === 'index' ? 8 : 0]
    const cursor = mapDrawingPoint(rawCursor, mapping, mirrored, this.logicalSize)
    this.hand = selected; this.cursor = cursor
    this.track(true)
    if (this.phase !== 'drawing' && this.phase !== 'dragging') this.phase = 'ready'
    if (!cursor) { this.liftForCursor('CURSOR_OUTSIDE_BOARD'); return this.result() }
    if (this.options.interactionMode === 'move') return this.moveCursor(cursor)
    if (this.options.mode === 'gesture') {
      const pointing = indexPointing(selected)
      this.gestureActive = pointing
      if (pointing !== true) {
        this.endStroke('gesture_inactive'); this.pointingFrames = 0; this.rejectionReason = 'GESTURE_INACTIVE'
        return this.result()
      }
      this.pointingFrames += 1
      if (this.pointingFrames < DRAWING_POLICY.gestureFrames) { this.rejectionReason = 'GESTURE_INACTIVE'; return this.result() }
    } else if (!this.penDown) { this.rejectionReason = 'PEN_UP'; return this.result() }
    return this.append(cursor, observation.timestamp, observation.frameId)
  }

  private moveCursor(cursor: Cursor): DrawingUpdate {
    this.endStroke('mode_changed'); this.penDown = false; this.gestureActive = null; this.pointingFrames = 0; this.rejectionReason = null
    const grab = this.grab
    if (!grab) {
      this.hoveredId = hitTestStroke(this.artwork, cursor, 22, this.displayScale)?.id ?? null
      this.phase = 'ready'
      return this.result()
    }
    if (Math.hypot((cursor.x - grab.last.x) / this.logicalSize.width, (cursor.y - grab.last.y) / this.logicalSize.height) > DRAWING_POLICY.cursorJump) {
      this.liftForCursor('CURSOR_JUMP'); return this.result()
    }
    this.grab = { ...grab, last: { ...cursor } }; this.phase = 'dragging'
    const before = grab.stroke.offset ?? { x: 0, y: 0 }
    const x = Math.max(-grab.bounds.left, Math.min(this.logicalSize.width - grab.bounds.right, before.x + cursor.x - grab.anchor.x))
    const y = Math.max(-grab.bounds.top, Math.min(this.logicalSize.height - grab.bounds.bottom, before.y + cursor.y - grab.anchor.y))
    const previous = this.artwork.find(stroke => stroke.id === grab.stroke.id)?.offset ?? { x: 0, y: 0 }
    if (previous.x === x && previous.y === y) return this.result()
    this.artwork = this.artwork.map(stroke => stroke.id === grab.stroke.id ? { ...stroke, offset: { x, y } } : stroke)
    this.interaction('drawing_drag_point', { drag_id: grab.id, stroke_id: grab.stroke.id, x: cursor.x, y: cursor.y, offset_x: x, offset_y: y, ...this.interactionCoordinates() }, true)
    return this.result(null, true)
  }

  /** The UI exposes this only for standalone demo input; it never saves patient results. */
  updatePointer(point: Cursor | null, now: number, down: boolean): DrawingUpdate {
    if (this.phase === 'finished' || this.paused) return this.result()
    this.researchContext = { timestamp: now }
    if (!point || ![point.x, point.y, now].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > this.logicalSize.width || point.y > this.logicalSize.height) {
      this.lose('CURSOR_OUTSIDE_BOARD'); return this.result()
    }
    if (this.lastTimestamp && now <= this.lastTimestamp) return this.result()
    if (this.lastTimestamp && now - this.lastTimestamp > DRAWING_POLICY.maxAgeMs) {
      this.endStroke('tracking_lost', true)
    }
    this.lastTimestamp = now; this.cursor = point; this.hand = null
    if (this.options.interactionMode === 'move') return this.moveCursor(point)
    this.phase = this.active ? 'drawing' : 'ready'; this.penDown = down
    if (!down) { this.endStroke('user_action'); return this.result() }
    return this.append(point, now)
  }

  private append(raw: Cursor, timestamp: number, frameId?: number): DrawingUpdate {
    const previous = this.active?.points.at(-1)
    if (previous && Math.hypot((raw.x - previous.x) / this.logicalSize.width, (raw.y - previous.y) / this.logicalSize.height) > DRAWING_POLICY.cursorJump) {
      this.liftForCursor('CURSOR_JUMP'); return this.result()
    }
    if (this.pointCount >= DRAWING_POLICY.maxPoints || (!this.active && this.artwork.length >= DRAWING_POLICY.maxStrokes)) {
      this.limitReached = true; this.endStroke('drawing_limit', true); this.penDown = false; this.rejectionReason = 'DRAWING_LIMIT'; return this.result()
    }
    const point: DrawingPoint = { x: previous ? previous.x * .2 + raw.x * .8 : raw.x, y: previous ? previous.y * .2 + raw.y * .8 : raw.y, timestamp, ...(frameId !== undefined ? { frameId } : {}) }
    if (!this.active) {
      this.pen(true, this.options.mode === 'gesture' ? 'gesture_active' : 'user_action')
      this.active = { id: ++this.sequence, color: this.options.color, width: this.options.width, mode: this.options.mode, points: [], startedAt: timestamp, endedAt: null, offset: { x: 0, y: 0 } }
      this.artwork.push(this.active); this.remember({ type: 'add', id: this.active.id })
      this.interaction('STROKE_STARTED', { stroke_id: this.active.id, color: this.active.color, pen_width: this.active.width, ...this.interactionCoordinates() })
    }
    this.active.points.push(point); this.pointCount += 1; this.metrics.acceptedUpdates += 1; this.phase = 'drawing'
    this.rejectionReason = null
    this.interaction('drawing_stroke_point', { stroke_id: this.active.id, x: point.x, y: point.y, ...this.interactionCoordinates() }, true)
    return this.result({ stroke: this.active, from: previous ?? null, to: point })
  }
}
