import { useCallback, useEffect, useState } from 'react'
export function useData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await load()) } catch (e) { setError(e instanceof Error ? e.message : 'Không tải được dữ liệu') } finally { setLoading(false) }
  }, [load])
  useEffect(() => { void reload() }, [reload])
  return { data, error, loading, reload }
}
