const hospitalTimeZone = import.meta.env.VITE_HOSPITAL_TIMEZONE || 'Asia/Bangkok'

/** Calendar date at the hospital; never slice a UTC timestamp for a date filter. */
export function hospitalDay(timestamp: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: hospitalTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
export const hospitalDate = (timestamp: string) => new Date(timestamp).toLocaleDateString('vi-VN', { timeZone: hospitalTimeZone })
export const hospitalDateTime = (timestamp: string) => new Date(timestamp).toLocaleString('vi-VN', { timeZone: hospitalTimeZone })
