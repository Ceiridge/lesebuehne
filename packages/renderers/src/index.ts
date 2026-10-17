/** @lesebuehne/renderers: visual state as a pure function of book time, stage scheduling, components. */
export { resolveCueTimes } from './state/cue-times.ts';
export {
  cueProgress,
  MAX_VISIBLE_TERMS,
  REVEAL_SECONDS,
  visualState,
  type ItemState,
  type Motion,
  type TermState,
  type VisualOptions,
  type VisualState,
} from './state/visual-state.ts';
export { MIN_DWELL_MS, StageScheduler, type StageFrame } from './stage/scheduler.ts';
export { KineticType, ListDiagram, QuoteCard, StageView, TitleCard, Visual } from './components/visuals.tsx';
