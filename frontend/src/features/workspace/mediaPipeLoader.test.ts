import { afterEach, describe, expect, it, vi } from 'vitest'
import { withOwnedMediaPipeLoader } from './mediaPipeLoader'

const files = { wasmLoaderPath: '/mediapipe/wasm/vision_wasm_internal.js', wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm' }
const scriptFor = (url: string) => { const script = document.createElement('script'); script.src = url; document.body.appendChild(script); return script }
afterEach(() => { document.querySelectorAll('script[data-loader-test]').forEach(script => script.remove()); vi.restoreAllMocks() })

describe('owned MediaPipe loader scripts', () => {
  it('removes only the unique loader after successful initialization', async () => {
    const unrelated = scriptFor(files.wasmLoaderPath); unrelated.dataset.loaderTest = 'yes'
    let own!: HTMLScriptElement
    const result = await withOwnedMediaPipeLoader(files, async isolated => {
      expect(isolated.wasmBinaryPath).toBe(files.wasmBinaryPath)
      expect(files.wasmLoaderPath).toBe('/mediapipe/wasm/vision_wasm_internal.js')
      own = scriptFor(isolated.wasmLoaderPath); own.dataset.loaderTest = 'yes'
      expect(own.isConnected).toBe(true)
      return 'ready'
    })
    expect(result).toBe('ready')
    expect(own.isConnected).toBe(false)
    expect(unrelated.isConnected).toBe(true)
  })

  it('keeps another pending initialization and its script intact on failure', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000')
    let release!: () => void
    let pendingScript!: HTMLScriptElement
    const pending = withOwnedMediaPipeLoader(files, async isolated => {
      pendingScript = scriptFor(isolated.wasmLoaderPath); pendingScript.dataset.loaderTest = 'yes'
      await new Promise<void>(resolve => { release = resolve })
      return 1
    })
    let failedScript!: HTMLScriptElement
    await expect(withOwnedMediaPipeLoader(files, async isolated => {
      failedScript = scriptFor(isolated.wasmLoaderPath); failedScript.dataset.loaderTest = 'yes'
      throw new Error('model failed')
    })).rejects.toThrow('model failed')
    expect(failedScript.isConnected).toBe(false)
    expect(pendingScript.isConnected).toBe(true)
    release()
    await expect(pending).resolves.toBe(1)
    expect(pendingScript.isConnected).toBe(false)
  })

  it('cleans both uniquely marked loader scripts when an asset loader is supplied', async () => {
    let scripts: HTMLScriptElement[] = []
    await withOwnedMediaPipeLoader({ ...files, assetLoaderPath: '/assets.js' }, async isolated => {
      scripts = [scriptFor(isolated.wasmLoaderPath), scriptFor(isolated.assetLoaderPath!)]
      scripts.forEach(script => { script.dataset.loaderTest = 'yes' })
    })
    expect(scripts.every(script => !script.isConnected)).toBe(true)
  })

  it('leaves an existing loader fragment and its script untouched', async () => {
    const custom = { ...files, wasmLoaderPath: `${files.wasmLoaderPath}#custom` }
    let script!: HTMLScriptElement
    await withOwnedMediaPipeLoader(custom, async same => {
      expect(same.wasmLoaderPath).toBe(custom.wasmLoaderPath)
      script = scriptFor(same.wasmLoaderPath); script.dataset.loaderTest = 'yes'
    })
    expect(script.isConnected).toBe(true)
  })
})
