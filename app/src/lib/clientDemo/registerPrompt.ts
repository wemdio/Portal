'use client';

/**
 * Bridge for the demo "register to unlock" modal (components/client/DemoRegisterGate).
 *
 * Demo accounts are blocked server-side on every mutating/tool action (403 with
 * code DEMO_READONLY — see clientApiHelper/blockDemo). authFetch peeks for that code
 * and calls promptDemoRegister(), and client-disabled controls that never hit the
 * server (e.g. the demo launch-preview button) call it directly. The gate listens
 * for this event and shows the modal — so ANY blocked action surfaces the CTA with
 * no per-call-site wiring. Lives in lib (not the component) so authFetch can dispatch
 * without importing React/components.
 */
export const DEMO_REGISTER_PROMPT_EVENT = 'demo-register-prompt';

export interface DemoRegisterPromptDetail {
  /** Verb phrase for the title, e.g. "запустить кампанию" → "Зарегистрируйтесь, чтобы …". */
  reason?: string;
}

export function promptDemoRegister(reason?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<DemoRegisterPromptDetail>(DEMO_REGISTER_PROMPT_EVENT, { detail: { reason } }),
  );
}
