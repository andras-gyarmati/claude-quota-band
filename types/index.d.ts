export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Multiplier = { value: number; measured: boolean }

export type Turn = { at: number; tokens: number | null; window: number | null; ttlMs: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-band': { limits: Limit[]; turn: Turn | null; multiplier: Multiplier | null; tick: number }
  }
}
