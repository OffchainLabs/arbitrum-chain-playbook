// Shared console logger and helpers for the timeboost playbook sub-modules.
//
// These sub-modules print with a bare emoji prefix (no color, not routed to the
// file logger), which is intentionally distinct from the global `utils/logger`
// used by the top-level orchestrator. The object below is the union of every
// method the sub-modules use; each implementation matches what they defined
// locally before being consolidated here.
export const log = {
  info: (m: string) => console.log('ℹ', m),
  warn: (m: string) => console.log('⚠', m),
  success: (m: string) => console.log('✔', m),
  section: (m: string) => console.log('\n▸', m, '\n'),
  event: (m: string) => console.log('•', m),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
