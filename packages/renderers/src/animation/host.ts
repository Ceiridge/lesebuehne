/** Startup and response limits of the sandbox (spec 003 B4). */
export const READY_TIMEOUT_MS = 5000;
export const TICK_TIMEOUT_MS = 2000;

export interface AnimationInit {
  /** Cue times relative to the section start (s). */
  cues: number[];
  items: Array<{ id: string; label: string; color?: string; glyph?: string; group?: string }>;
  terms: string[];
  palette: { background: string; ink: string; accent: string; accent2: string; muted: string };
  motion: 'full' | 'reduced' | 'none';
}

export type SandboxStatus = { state: 'loading' } | { state: 'running' } | { state: 'failed'; reason: string };

/** The frame side as the host sees it (an iframe's window, or a fake in tests). */
export interface FramePort {
  post(message: unknown): void;
}

/**
 * Host side of the sandbox protocol: `init` once, `seek` when `t` changes; accepts `ready`,
 * `tick` and `error` only from its own frame with its nonce; a watchdog fails the frame when it
 * does not become ready or stops answering.
 */
export class SandboxHost {
  readonly nonce = crypto.randomUUID();
  status: SandboxStatus = { state: 'loading' };
  private started: number | undefined;
  private lastSent: number | undefined;
  private pendingSince: number | undefined;

  constructor(
    private readonly port: FramePort,
    private readonly init: AnimationInit,
    private readonly now: () => number,
    private readonly onStatus: (s: SandboxStatus) => void = () => undefined,
  ) {}

  /** The frame document loaded: send `init`. */
  loaded(): void {
    this.started = this.now();
    this.port.post({ type: 'init', nonce: this.nonce, ...this.init });
  }

  private set(s: SandboxStatus): void {
    if (this.status.state === 'failed') return;
    this.status = s;
    this.onStatus(s);
  }

  fail(reason: string): void {
    this.set({ state: 'failed', reason });
  }

  /** A message from the frame window (the caller checks `event.source`). */
  receive(data: unknown): void {
    const m = data as { type?: string; nonce?: string; message?: string } | null;
    if (!m || m.nonce !== this.nonce) return;
    if (m.type === 'ready') this.set({ state: 'running' });
    else if (m.type === 'tick') this.pendingSince = undefined;
    else if (m.type === 'error') this.fail(String(m.message ?? 'error').slice(0, 300));
  }

  /** Called every frame with the section time. */
  seek(t: number): void {
    const now = this.now();
    if (this.status.state === 'loading' && this.started !== undefined && now - this.started > READY_TIMEOUT_MS) this.fail('did not start in time');
    if (this.status.state !== 'running') return;
    if (this.pendingSince !== undefined && now - this.pendingSince > TICK_TIMEOUT_MS) {
      this.fail('stopped responding');
      return;
    }
    if (this.lastSent === t) return;
    this.lastSent = t;
    this.pendingSince ??= now;
    this.port.post({ type: 'seek', t });
  }
}
