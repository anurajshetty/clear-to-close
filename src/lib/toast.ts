// Clear to Close — toast timing (Sept 28, 2026).
//
// Every toast auto-dismisses on its own timer and supports tap-to-dismiss.
// The timer lives here, owned by the ToastTimer instance — never inside a
// component effect that also mutates unrelated state (route params, sheet
// visibility, ...). That was the Sept 28 "Added to your escrows." stuck-toast
// bug: the dismiss setTimeout was armed in the same useEffect that consumed
// the `added` route param, so the param change re-rendered the screen, the
// effect re-ran, and its cleanup (clearTimeout) cancelled the dismiss timer —
// the toast appeared and never left.
//
// Framework-free on purpose: the node unit suite drives it with a manual
// clock (see tests/toast_dismiss.test.ts). React screens subscribe to
// visibility and call show()/dismiss().
export const TOAST_DISMISS_MS = 3000;

/** Schedules cb after ms; returns a canceller. Defaults to real timers. */
export type ToastScheduler = (cb: () => void, ms: number) => () => void;

const realScheduler: ToastScheduler = (cb, ms) => {
  const t = setTimeout(cb, ms);
  return () => clearTimeout(t);
};

export class ToastTimer {
  private cancel: (() => void) | null = null;
  private _visible = false;
  private listeners = new Set<(visible: boolean) => void>();

  constructor(private readonly schedule: ToastScheduler = realScheduler) {}

  get visible(): boolean {
    return this._visible;
  }

  subscribe(fn: (visible: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setVisible(v: boolean): void {
    if (this._visible === v) return;
    this._visible = v;
    this.listeners.forEach((fn) => fn(v));
  }

  /** Show the toast and (re)arm the auto-dismiss timer. */
  show(): void {
    this.cancel?.();
    this.cancel = null;
    this.setVisible(true);
    this.cancel = this.schedule(() => {
      this.cancel = null;
      this.setVisible(false);
    }, TOAST_DISMISS_MS);
  }

  /** Hide immediately (tap-to-dismiss); a pending timer is neutralised. */
  dismiss(): void {
    this.cancel?.();
    this.cancel = null;
    this.setVisible(false);
  }
}
