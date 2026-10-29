type LoaderFiles = { wasmLoaderPath: string; wasmBinaryPath: string; assetLoaderPath?: string }
let sequence = 0

/** MediaPipe 0.10.35 appends loader scripts to document.body without removing them.
 * Give this initialization unique URL fragments, then remove only its scripts after
 * initialization settles. Fragments do not change the fetched HTTP resource.
 * This helper is for the document-based loader, not importScripts in a Worker.
 */
export async function withOwnedMediaPipeLoader<T extends LoaderFiles, Result>(
  files: T,
  initialize: (isolated: T) => Promise<Result>,
): Promise<Result> {
  const randomId = globalThis.crypto?.randomUUID?.()
  const id = randomId && `${randomId}-${++sequence}`
  if (!id || typeof document === 'undefined') return initialize(files)

  const wasm = new URL(files.wasmLoaderPath, document.baseURI)
  const asset = files.assetLoaderPath ? new URL(files.assetLoaderPath, document.baseURI) : undefined
  // An existing fragment may have meaning to another caller. Leave it untouched.
  if (wasm.hash || asset?.hash) return initialize(files)
  wasm.hash = `rehab-loader-${id}-wasm`
  if (asset) asset.hash = `rehab-loader-${id}-asset`
  const owned = new Set([wasm.href, ...(asset ? [asset.href] : [])])
  const isolated = { ...files, wasmLoaderPath: wasm.href, ...(asset ? { assetLoaderPath: asset.href } : {}) }
  try {
    return await initialize(isolated)
  } finally {
    for (const script of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
      if (owned.has(script.src)) script.remove()
    }
  }
}
