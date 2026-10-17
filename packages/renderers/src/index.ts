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
  type EdgeState,
  type VisualOptions,
  type VisualState,
} from './state/visual-state.ts';
export { MIN_DWELL_MS, StageScheduler, type StageFrame } from './stage/scheduler.ts';
export { KineticType, ListDiagram, QuoteCard, StageView, TitleCard, Visual } from './components/visuals.tsx';
export { DiagramView } from './components/diagram.tsx';
export { ImageView, Placeholder } from './components/image.tsx';
export { cameraAt, cameraFor, CAMERA_MOVE_SECONDS, type Camera } from './state/camera.ts';
export { AnimationView, type AnimationStatusListener } from './components/animation.tsx';
export { READY_TIMEOUT_MS, SandboxHost, TICK_TIMEOUT_MS, type AnimationInit, type FramePort, type SandboxStatus } from './animation/host.ts';
export { LIBRARY_SOURCE, SANDBOX_CSP, sandboxDocument } from './animation/library.ts';
export { effectiveTemplate, layoutDiagram, sceneFor, wrap, SCENE_HEIGHT, SCENE_WIDTH, type Scene, type SceneDecor, type SceneEdge, type SceneNode } from './diagram/layout.ts';
