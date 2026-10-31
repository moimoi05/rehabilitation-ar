import { useCallback, useEffect, useRef, useState } from 'react'
export function useData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setError(''); setData(null)
    try {
      const value = await load()
      if (request === generation.current) setData(value)
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : 'Không tải được dữ liệu')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [load])
  useEffect(() => { void reload(); return () => { generation.current += 1 } }, [reload])
  return { data, error, loading, reload }
}
