/** An explicit saved choice takes precedence over the earlier opt-in flag. Defaults to true (dedicated GPU Worker). */
export const resolveWorkerPreference = (value: unknown, legacy: string | null): boolean =>
  typeof value === 'boolean' ? value : legacy === 'disabled' ? false : true
