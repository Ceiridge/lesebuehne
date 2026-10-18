import { useEffect, useMemo, useState } from 'preact/hooks';
import { ACTIVITY_KINDS, activity, activityHistory, HISTORY_POINTS, kindOfKey, resetActivity, sampleActivity, type HistoryPoint, type QueueView } from '../../ai/activity.ts';
import type { ProviderStatus } from '../../ai/backends.ts';
import { ImageSequencePlanner } from '../../ai/image-sequence.ts';
import { readyPercent } from '../../ai/progress.ts';
import { aiBackend, ttsBuffer } from '../../ai/state.ts';
import { ttsStatus } from '../../ai/tts.ts';
import { throughputState } from '../../ai/throughput.ts';
import type { ReaderSession } from '../../app/session.ts';
import { t, uiLanguage, type MessageKey } from '../../i18n/i18n.ts';
import { bookWords, generationRates } from './GenerationProgress.tsx';

const SAMPLE_MS = 2000;

/** The queues behind generation: speech clips, plans and animations, images. */
export function queueViews(session: ReaderSession): QueueView[] {
  const out: QueueView[] = [];
  const speech = ttsBuffer.peek()?.queueSnapshot();
  if (speech) out.push({ id: 'speech', snapshot: speech });
  const ai = session.ai;
  if (ai instanceof ImageSequencePlanner) out.push({ id: 'images', snapshot: ai.queueSnapshot() });
  else if (ai) {
    const q = ai.queues();
    out.push({ id: 'plans', snapshot: q.plans }, { id: 'images', snapshot: q.images });
  }
  return out;
}

/** Samples the generation pace every two seconds while a book is open (for the info charts). */
export function useActivitySampler(session: ReaderSession): void {
  useEffect(() => {
    const words = bookWords(session);
    const timer = setInterval(() => {
      const rates = generationRates(session, words);
      const queues = queueViews(session);
      const ratio = (r: (typeof rates)['speech']): number | undefined => (r.enabled && r.speed !== undefined && r.target > 0 ? r.speed / r.target : undefined);
      const point: HistoryPoint = {
        at: Date.now(),
        running: queues.reduce((n, q) => n + q.snapshot.running.length, 0),
        queued: queues.reduce((n, q) => n + q.snapshot.queued.length, 0),
      };
      const speech = ratio(rates.speech);
      const stage = ratio(rates.stage);
      if (speech !== undefined) point.speech = speech;
      if (stage !== undefined) point.stage = stage;
      if (rates.speech.enabled && ttsStatus.peek().aheadSeconds !== undefined) point.ahead = ttsStatus.peek().aheadSeconds!;
      sampleActivity(point);
    }, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [session]);
}

const fmt = (n: number, digits = 0): string => n.toLocaleString(uiLanguage.value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const duration = (seconds: number): string => {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} s`;
};
const short = (text: string, max = 70): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()} …` : text);

/** The next round axis maximum: 1, 1.5, 2, 3, 4, 5, 6, 8 or 10 times a power of ten. */
function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  return ([1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p;
}

interface Series {
  id: string;
  label: string;
  values: Array<number | undefined>;
  format: (v: number) => string;
}

/**
 * A small line chart over the last ten minutes (one sample per two seconds). One y-scale, a dashed
 * reference line, legend for two or more series, crosshair with values on hover.
 */
function LineChart({ title, series, reference, minMax }: { title: string; series: Series[]; reference?: { value: number; label: string }; minMax: number }) {
  const [hover, setHover] = useState<number>();
  const W = 600;
  const H = 120;
  const pad = { top: 10, right: 8, bottom: 18, left: 34 };
  const n = HISTORY_POINTS;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== undefined));
  const top = niceCeil(Math.max(minMax, reference ? reference.value * 1.25 : 0, ...all));
  const max = top * 1.06;
  const x = (i: number, len: number): number => pad.left + ((n - len + i) / (n - 1)) * (W - pad.left - pad.right);
  const y = (v: number): number => pad.top + (1 - v / max) * (H - pad.top - pad.bottom);
  const path = (values: Array<number | undefined>): string => {
    let d = '';
    let open = false;
    values.forEach((v, i) => {
      if (v === undefined) { open = false; return; }
      d += `${open ? 'L' : 'M'}${x(i, values.length).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    });
    return d;
  };
  const len = series[0]?.values.length ?? 0;
  const empty = all.length === 0;
  const ticks = [0, top / 2, top];
  const onMove = (e: PointerEvent): void => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - pad.left) / (W - pad.left - pad.right)) * (n - 1)) - (n - len);
    setHover(i >= 0 && i < len ? i : undefined);
  };
  const hx = hover === undefined ? 0 : x(hover, len);
  return (
    <figure class="info-chart">
      <figcaption>{title}</figcaption>
      {series.length > 1 ? (
        <div class="info-legend">
          {series.map((s) => <span key={s.id} class={`info-series-${s.id}`}><i aria-hidden="true" />{s.label}</span>)}
        </div>
      ) : null}
      <div class="info-chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
          {ticks.map((v) => <line key={v} class="info-grid" x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} />)}
          {reference ? <line class="info-reference" x1={pad.left} x2={W - pad.right} y1={y(reference.value)} y2={y(reference.value)} /> : null}
          {series.map((s) => <path key={s.id} class={`info-line info-series-${s.id}`} d={path(s.values)} />)}
          {hover !== undefined ? <line class="info-crosshair" x1={hx} x2={hx} y1={pad.top} y2={H - pad.bottom} /> : null}
          {hover !== undefined ? series.map((s) => s.values[hover] === undefined ? null : <circle key={s.id} class={`info-dot info-series-${s.id}`} cx={hx} cy={y(s.values[hover]!)} r={4} />) : null}
        </svg>
        <div class="info-axis-y" aria-hidden="true">{[...ticks].reverse().map((v) => <span key={v}>{fmt(v, v % 1 ? 1 : 0)}</span>)}</div>
        <div class="info-axis-x" aria-hidden="true"><span>{t('info.chart.ago', { n: 10 })}</span><span>{t('info.chart.now')}</span></div>
        {reference ? <span class="info-reference-label" style={{ top: `${(y(reference.value) / H) * 100}%` }}>{reference.label}</span> : null}
        {hover !== undefined ? (
          <div class="info-tooltip" style={{ left: `${(hx / W) * 100}%` }}>
            {series.map((s) => <span key={s.id} class={`info-series-${s.id}`}><i aria-hidden="true" />{s.label}: {s.values[hover] === undefined ? '—' : s.format(s.values[hover]!)}</span>)}
          </div>
        ) : null}
        {empty ? <p class="info-chart-empty">{t('info.chart.empty')}</p> : null}
      </div>
    </figure>
  );
}

function QueueRow({ view, session }: { view: QueueView; session: ReaderSession }) {
  const { running, queued, concurrency } = view.snapshot;
  const label = (key: string): string => {
    if (view.id === 'plans') {
      if (key === 'style') return t('info.queue.style');
      const sectionId = key.slice(key.indexOf(':') + 1).replace(/:r$/u, '');
      return `${t(`info.kind.${kindOfKey(key)}` as MessageKey)} · ${short(session.sectionTitle(sectionId) || sectionId, 50)}`;
    }
    if (view.id === 'images' && key.startsWith('img:')) return short(session.sectionTitle(key.slice(4).replace(/:r$/u, '')) || key, 60);
    return short(key);
  };
  return (
    <div class="info-queue">
      <div class="info-queue-head">
        <strong>{t(`info.queue.${view.id}`)}</strong>
        <span>{t('info.queue.counts', { running: running.length, slots: concurrency, queued: queued.length })}</span>
      </div>
      <div class="info-meter" aria-hidden="true">
        {Array.from({ length: concurrency }, (_, i) => <i key={i} class={i < running.length ? 'is-busy' : ''} />)}
      </div>
      {running.length ? <ul class="info-jobs">{running.map((k) => <li key={k} class="is-running">{label(k)}</li>)}</ul> : null}
      {queued.length ? <p class="info-next">{t('info.queue.next')}: {queued.slice(0, 3).map(label).join(' · ')}{queued.length > 3 ? ` · +${queued.length - 3}` : ''}</p> : null}
    </div>
  );
}

function sumUsage(providers: ProviderStatus[]) {
  return providers.reduce((a, p) => ({
    calls: a.calls + (p.usage?.calls ?? 0),
    errors: a.errors + (p.usage?.errors ?? 0),
    input: a.input + (p.usage?.inputTokens ?? 0),
    output: a.output + (p.usage?.outputTokens ?? 0),
    cost: a.cost + (p.usage?.cost ?? 0),
  }), { calls: 0, errors: 0, input: 0, output: 0, cost: 0 });
}

const money = (usd: number): string => (usd > 0 ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : '—');

/** Settings → Info: what was generated, what runs now, whether it keeps up, tokens and costs. */
export function InfoSettings({ session }: { session: ReaderSession }) {
  const backend = aiBackend.value;
  const [, setTick] = useState(0);
  const [providers, setProviders] = useState<ProviderStatus[]>();
  useEffect(() => {
    // Queues are plain objects, not signals: refresh the view every second while it is open.
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    const load = (): void => void backend?.status().then((s) => live && setProviders(s.providers), () => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [backend]);

  const words = useMemo(() => bookWords(session), [session]);
  const rates = generationRates(session, words);
  const history = activityHistory.value;
  const log = activity.value;
  const queues = queueViews(session);
  const progress = session.generation.value;
  const bookDuration = session.timeline.duration;
  const used = (providers ?? []).filter((p) => (p.usage?.calls ?? 0) > 0 || p.available);
  const total = sumUsage(used);
  const ratioFormat = (v: number): string => `${fmt(v, 2)}×`;

  return <>
    <header class="settings-intro"><h3>{t('settings.tab.info')}</h3><p>{t('info.hint')}</p></header>

    <section class="info-block">
      <h4>{t('info.pace')}</h4>
      <div class="info-tiles">
        {(['speech', 'stage'] as const).map((kind) => {
          const r = rates[kind];
          const ratio = r.speed !== undefined && r.target > 0 ? r.speed / r.target : undefined;
          const state = throughputState(r.speed, r.target);
          return (
            <div key={kind} class={`info-tile info-series-${kind} is-${r.enabled ? state : 'off'}`}>
              <span class="info-tile-label"><i aria-hidden="true" />{t(`info.${kind}`)}</span>
              <strong>{!r.enabled ? t('info.off') : ratio === undefined ? '—' : ratioFormat(ratio)}</strong>
              <span>{!r.enabled ? '' : ratio === undefined ? t('info.measuring') : t(`generation.pace.${state}`)}</span>
              {kind === 'speech' && r.enabled && ttsStatus.value.aheadSeconds !== undefined ? <span class="info-tile-extra">{t('info.buffer', { time: duration(ttsStatus.value.aheadSeconds) })}</span> : null}
            </div>
          );
        })}
      </div>
      <p class="field-hint">{t('info.pace.hint')}</p>
      <LineChart
        title={t('info.chart.pace')}
        minMax={1.5}
        reference={{ value: 1, label: '1×' }}
        series={[
          { id: 'speech', label: t('info.speech'), values: history.map((p) => p.speech), format: ratioFormat },
          { id: 'stage', label: t('info.stage'), values: history.map((p) => p.stage), format: ratioFormat },
        ]}
      />
      <LineChart title={t('info.chart.buffer')} minMax={30} series={[{ id: 'speech', label: t('info.speech'), values: history.map((p) => p.ahead), format: (v) => duration(v) }]} />
    </section>

    <section class="info-block">
      <h4>{t('info.queue')}</h4>
      {queues.length ? queues.map((q) => <QueueRow key={q.id} view={q} session={session} />) : <p class="field-hint">{t('info.queue.idle')}</p>}
      <LineChart
        title={t('info.chart.queue')}
        minMax={4}
        series={[
          { id: 'running', label: t('info.chart.running'), values: history.map((p) => p.running), format: (v) => fmt(v) },
          { id: 'queued', label: t('info.chart.queued'), values: history.map((p) => p.queued), format: (v) => fmt(v) },
        ]}
      />
    </section>

    <section class="info-block">
      <h4>{t('info.progress')}</h4>
      {(['speech', 'stage'] as const).map((kind) => {
        const percent = readyPercent(progress[kind], bookDuration);
        return (
          <div key={kind} class={`info-progress info-series-${kind}`}>
            <span>{t(`info.${kind}`)}</span>
            <span class="info-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={t(`info.${kind}`)}><i style={{ width: `${percent}%` }} /></span>
            <span class="info-num">{fmt(percent, 1)} %</span>
          </div>
        );
      })}
    </section>

    <section class="info-block">
      <h4>{t('info.session')} <small>{t('info.session.since', { time: new Date(log.since).toLocaleTimeString(uiLanguage.value, { hour: '2-digit', minute: '2-digit' }) })}</small></h4>
      <div class="info-table-wrap">
        <table class="info-table">
          <thead><tr><th>{t('info.col.kind')}</th><th>{t('info.col.new')}</th><th>{t('info.col.cached')}</th><th>{t('info.col.failed')}</th><th>{t('info.col.avg')}</th><th>{t('info.col.amount')}</th></tr></thead>
          <tbody>
            {ACTIVITY_KINDS.map((kind) => {
              const k = log.totals[kind];
              return (
                <tr key={kind}>
                  <th scope="row">{t(`info.kind.${kind}`)}</th>
                  <td>{fmt(k.new)}</td>
                  <td>{fmt(k.cached)}</td>
                  <td class={k.failed ? 'is-bad' : ''}>{fmt(k.failed)}</td>
                  <td>{k.new ? duration(k.ms / k.new / 1000) : '—'}</td>
                  <td>{kind === 'speech' && k.audioSeconds ? t('info.amount.audio', { min: fmt(k.audioSeconds / 60, 1) }) : kind === 'image' && k.pictures ? t('info.amount.pictures', { n: k.pictures }) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="button" class="btn btn-ghost small" onClick={() => resetActivity()}>{t('info.reset')}</button>
    </section>

    <section class="info-block">
      <h4>{t('info.providers')}</h4>
      <p class="field-hint">{t(backend?.mode === 'browser' ? 'info.providers.hintBrowser' : 'info.providers.hint')}</p>
      {!backend ? <p class="field-hint">{t('info.providers.empty')}</p> : (
        <div class="info-table-wrap">
          <table class="info-table">
            <thead><tr><th>{t('info.col.provider')}</th><th>{t('info.col.calls')}</th><th>{t('info.col.errors')}</th><th>{t('info.col.tokensIn')}</th><th>{t('info.col.tokensOut')}</th><th>{t('info.col.cost')}</th></tr></thead>
            <tbody>
              {used.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.label}{p.kind ? <small>{p.kind}</small> : null}</th>
                  <td>{fmt(p.usage?.calls ?? 0)}</td>
                  <td class={p.usage?.errors ? 'is-bad' : ''}>{fmt(p.usage?.errors ?? 0)}{p.usage?.rateLimits ? ` (${fmt(p.usage.rateLimits)} 429)` : ''}</td>
                  <td>{fmt(p.usage?.inputTokens ?? 0)}</td>
                  <td>{fmt(p.usage?.outputTokens ?? 0)}</td>
                  <td>{money(p.usage?.cost ?? 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">{t('info.total')}</th><td>{fmt(total.calls)}</td><td>{fmt(total.errors)}</td><td>{fmt(total.input)}</td><td>{fmt(total.output)}</td><td>{money(total.cost)}</td></tr></tfoot>
          </table>
        </div>
      )}
    </section>

    <section class="info-block">
      <h4>{t('info.recent')}</h4>
      {log.recent.length ? (
        <ul class="info-recent">
          {log.recent.slice(0, 15).map((e, i) => (
            <li key={`${e.at}-${i}`} class={`is-${e.outcome}`}>
              <time>{new Date(e.at).toLocaleTimeString(uiLanguage.value)}</time>
              <span class="info-recent-kind">{t(`info.kind.${e.kind}`)}</span>
              <span class="info-recent-what">{short(e.label ?? (e.sectionId ? session.sectionTitle(e.sectionId) : '') ?? '', 60)}</span>
              <span class="info-recent-outcome">{t(`info.outcome.${e.outcome}`)}{e.outcome === 'new' ? ` · ${duration(e.ms / 1000)}` : ''}</span>
            </li>
          ))}
        </ul>
      ) : <p class="field-hint">{t('info.recent.empty')}</p>}
    </section>
  </>;
}

