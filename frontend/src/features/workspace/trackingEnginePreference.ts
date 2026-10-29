/** An explicit saved choice takes precedence over the earlier opt-in flag. */
export const resolveWorkerPreference = (value: unknown, legacy: string | null): boolean =>
  typeof value === 'boolean' ? value : legacy === 'enabled'
