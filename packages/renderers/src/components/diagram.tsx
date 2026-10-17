import { wrap, type SceneDecor, type SceneNode } from '../diagram/layout.ts';
import type { EdgeState, ItemState, VisualState } from '../state/visual-state.ts';

type DiagramVisual = Extract<VisualState, { mode: 'diagram' }>;

const LINE = 1.22;

function Label({ n }: { n: SceneNode }) {
  const lines = n.lines;
  const total = lines.length * n.fontSize * LINE;
  const baseY =
    n.textAt === 'above' ? n.y - n.h / 2 - 22 - total + n.fontSize : n.textAt === 'below' ? n.y + n.h / 2 + 22 + n.fontSize : n.y - total / 2 + n.fontSize * 0.86 - (n.detail && n.h >= 90 ? 12 : 0);
  const captionY = n.textAt === 'center' ? n.y - n.h / 2 + 30 : n.textAt === 'above' ? baseY - n.fontSize * 1.1 : n.y + n.h / 2 + 22 + total + 22;
  return (
    <>
      {n.caption ? (
        <text class="lb-d-caption" x={n.x} y={captionY} text-anchor="middle">
          {n.caption}
        </text>
      ) : null}
      <text class="lb-d-label" x={n.x} y={baseY} text-anchor="middle" style={{ fontSize: `${n.fontSize}px` }}>
        {lines.map((l, k) => (
          <tspan key={k} x={n.x} dy={k === 0 ? 0 : n.fontSize * LINE}>
            {l}
          </tspan>
        ))}
      </text>
    </>
  );
}

function Shape({ n, item }: { n: SceneNode; item: ItemState | undefined }) {
  const cls = `lb-d-shape${item?.current ? ' is-current' : ''}`;
  if (n.shape === 'dot') return <circle class={`${cls} lb-d-dot`} cx={n.x} cy={n.y} r={n.w / 2} />;
  if (n.shape === 'circle') return <circle class={cls} cx={n.x} cy={n.y} r={n.w / 2} />;
  const radius = n.shape === 'pill' ? n.h / 2 : 18;
  return <rect class={cls} x={n.x - n.w / 2} y={n.y - n.h / 2} width={n.w} height={n.h} rx={radius} />;
}

function Decor({ d, k }: { d: SceneDecor; k: number }) {
  switch (d.kind) {
    case 'line':
      return <line class={`lb-d-decor tone-${d.tone}`} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke-width={d.width} stroke={d.tone === 'gradient' ? `url(#lb-grad)` : undefined} />;
    case 'circle':
      return <circle class={`lb-d-set tone-${d.tone}${d.fill ? ' is-filled' : ''}`} cx={d.cx} cy={d.cy} r={d.r} />;
    case 'rect':
      return <rect class={`lb-d-decor tone-${d.tone}`} x={d.x} y={d.y} width={d.w} height={d.h} />;
    case 'text':
      return (
        <text key={k} class={`lb-d-text tone-${d.tone}`} x={d.x} y={d.y} text-anchor={d.anchor} style={{ fontSize: `${d.size}px`, fontWeight: d.weight }}>
          {d.text}
        </text>
      );
  }
}

/** SVG diagram (M3): layout from the template engine, reveal/highlight/dim/connect from τ. */
export function DiagramView({ state }: { state: DiagramVisual }) {
  const { scene } = state;
  const items = new Map(state.items.map((i) => [i.id, i]));
  const edgeState = new Map<string, EdgeState>(state.edges.map((e) => [`${e.from}>${e.to}`, e]));
  return (
    <figure class={`lb-visual lb-diagram lb-template-${scene.template}`} aria-hidden="true">
      <svg viewBox={`0 0 ${scene.width} ${scene.height}`} preserveAspectRatio="xMidYMid meet" role="presentation">
        <defs>
          <marker id="lb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" class="lb-d-arrowhead" />
          </marker>
          <linearGradient id="lb-grad" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" class="lb-d-grad-a" />
            <stop offset="1" class="lb-d-grad-b" />
          </linearGradient>
        </defs>
        {scene.title ? (
          <text class="lb-d-title" x={scene.width / 2} y={86} text-anchor="middle">
            {scene.title}
          </text>
        ) : null}
        {scene.decor.map((d, k) => (
          <Decor key={k} d={d} k={k} />
        ))}
        {scene.edges.map((e) => {
          const s = edgeState.get(`${e.from}>${e.to}`);
          const p = s?.progress ?? 1;
          return (
            <g key={`${e.from}>${e.to}`} class="lb-d-edge" style={{ opacity: p > 0 ? 1 : 0 }}>
              <path
                d={e.d}
                pathLength={1}
                class={e.dashed ? 'lb-d-line is-dashed' : 'lb-d-line'}
                style={e.dashed ? { opacity: p } : { strokeDasharray: 1, strokeDashoffset: 1 - p }}
                marker-end={e.arrow && p >= 0.98 ? 'url(#lb-arrow)' : undefined}
              />
              {e.label && e.labelX !== undefined && e.labelY !== undefined ? (
                <text class="lb-d-edge-label" x={e.labelX} y={e.labelY} text-anchor="middle" style={{ opacity: p }}>
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {scene.nodes.map((n) => {
          const item = items.get(n.id);
          const opacity = (item?.opacity ?? 1) * (item?.dimmed ? 0.35 : 1);
          return (
            <g
              key={n.id}
              class={`lb-d-node${item?.current ? ' is-current' : ''}`}
              style={{ opacity, transform: `translateY(${(item?.offsetY ?? 0).toFixed(2)}px)`, ...(item?.color ? { '--lb-concept': item.color } : {}) }}
            >
              <Shape n={n} item={item} />
              {item?.glyph && n.shape !== 'dot' ? (
                // Glossary glyph as a badge on the top-left corner, clear of the label.
                <g class="lb-d-badge">
                  <circle cx={n.x - n.w / 2 + (n.shape === 'pill' ? n.h / 2 : 22)} cy={n.y - n.h / 2} r={19} />
                  <text class="lb-d-glyph" x={n.x - n.w / 2 + (n.shape === 'pill' ? n.h / 2 : 22)} y={n.y - n.h / 2 + 8} text-anchor="middle">
                    {item.glyph}
                  </text>
                </g>
              ) : null}
              <Label n={n} />
              {n.detail && n.textAt === 'center' && n.shape !== 'dot' && n.h >= 90 ? (
                <text class="lb-d-detail" x={n.x} y={n.y + n.h / 2 - 14} text-anchor="middle">
                  {wrap(n.detail, Math.floor(n.w / 12), 1)[0]}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
