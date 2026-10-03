export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Turn = { at: number; tokens: number | null; ttlMs: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-band': { limits: Limit[]; turn: Turn | null; tick: number }
  }
}
