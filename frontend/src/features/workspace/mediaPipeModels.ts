import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'
import { withOwnedMediaPipeLoader } from './mediaPipeLoader'

type VisionFiles = Parameters<typeof PoseLandmarker.createFromOptions>[0]
export type ModelDelegate = 'GPU' | 'CPU'
export type InitializedModel<T> = { model: T; delegate: ModelDelegate; gpuError: string | null }
export const modelErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Delegate labels describe the successful createFromOptions call, not WebGL availability.
 * Each model falls back independently. Constructors own cleanup when they reject;
 * once returned, the caller owns close(), including cancellation during initialization.
 */
async function initialize<T>(name: string, create: (delegate: ModelDelegate) => Promise<T>, preferGpu: boolean): Promise<InitializedModel<T>> {
  let gpuError: string | null = null
  if (preferGpu) {
    try { return { model: await create('GPU'), delegate: 'GPU', gpuError: null } }
    catch (error) {
      gpuError = modelErrorMessage(error)
      console.warn(`${name} GPU initialization failed; attempting CPU: ${gpuError}`)
    }
  }
  try { return { model: await create('CPU'), delegate: 'CPU', gpuError } }
  catch (error) { throw new Error(`${name} initialization failed. ${gpuError === null ? '' : `GPU: ${gpuError}. `}CPU: ${modelErrorMessage(error)}`) }
}

export const initializePose = (files: VisionFiles, preferGpu = true, canvas?: HTMLCanvasElement | OffscreenCanvas) => initialize('Pose', delegate =>
  withOwnedMediaPipeLoader(files, isolated => PoseLandmarker.createFromOptions(isolated, {
    ...(canvas ? { canvas } : {}), baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate }, runningMode: 'VIDEO', numPoses: 1,
  })), preferGpu)

export const initializeHand = (files: VisionFiles, preferGpu = true, canvas?: HTMLCanvasElement | OffscreenCanvas) => initialize('Hand', delegate =>
  withOwnedMediaPipeLoader(files, isolated => HandLandmarker.createFromOptions(isolated, {
    ...(canvas ? { canvas } : {}), baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate }, runningMode: 'VIDEO', numHands: 2,
  })), preferGpu)
