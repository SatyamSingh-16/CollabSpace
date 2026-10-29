// A short-lived message for the next page (for example "Deleted “Plan”."
// after leaving a deleted document). Kept in memory only. Reading it doesn't
// consume it, so React may call the reader twice (StrictMode); it simply
// expires after a few seconds.
const TTL_MS = 5_000
let flash: { text: string; at: number } | null = null

export function setFlash(text: string) {
  flash = { text, at: Date.now() }
}

export function recentFlash(): string | null {
  return flash && Date.now() - flash.at < TTL_MS ? flash.text : null
}
