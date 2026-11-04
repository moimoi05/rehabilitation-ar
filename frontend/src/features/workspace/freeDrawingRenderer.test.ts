import { describe, expect, it, vi } from 'vitest'
import type { DrawingStroke } from './freeDrawing'
import { drawDrawingOverlay, redrawDrawing } from './freeDrawingRenderer'

const size = { width: 1000, height: 562.5 }
const mapping = { box: size, rect: { x: 0, y: 0, ...size } }
const movedStroke: DrawingStroke = {
  id: 1, color: '#f472b6', width: 5, mode: 'assisted', startedAt: 1, endedAt: 3,
  points: [{ x: 100, y: 100, timestamp: 1 }, { x: 120, y: 110, timestamp: 2 }, { x: 140, y: 100, timestamp: 3 }],
  offset: { x: 200, y: 50 },
}

function canvasContext() {
  return {
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(),
  }
}

describe('Free Drawing saved-path rendering', () => {
  it('rebuilds each moved polyline as one continuous path for drag preview and PNG', () => {
    const ctx = canvasContext()
    redrawDrawing(ctx as unknown as CanvasRenderingContext2D, [movedStroke], size, size)
    expect(ctx.moveTo).toHaveBeenCalledWith(300, 150)
    expect(ctx.lineTo.mock.calls).toEqual([[320, 160], [340, 150]])
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.save).toHaveBeenCalledTimes(1)
  })

  it('highlights the same translated polyline without rebuilding each segment', () => {
    const ctx = canvasContext()
    drawDrawingOverlay(ctx as unknown as CanvasRenderingContext2D,
      { cursor: null, hand: null, drawing: false, highlightedStrokes: [movedStroke] }, mapping, false, size, size)
    expect(ctx.moveTo).toHaveBeenCalledWith(300, 150)
    expect(ctx.lineTo.mock.calls).toEqual([[320, 160], [340, 150]])
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('keeps a single-point stroke visible at its translated location', () => {
    const ctx = canvasContext()
    redrawDrawing(ctx as unknown as CanvasRenderingContext2D, [{ ...movedStroke, points: movedStroke.points.slice(0, 1) }], size, size)
    expect(ctx.arc).toHaveBeenCalledWith(300, 150, 2.5, 0, Math.PI * 2)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
  })
})
