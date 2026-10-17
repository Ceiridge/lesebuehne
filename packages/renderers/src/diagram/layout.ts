import type { Diagram, DiagramTemplate } from '@lesebuehne/core';

/** Canvas of every diagram scene (SVG viewBox); the stage scales it. */
export const SCENE_WIDTH = 1600;
export const SCENE_HEIGHT = 900;
const MARGIN = 60;

export interface SceneNode {
  id: string;
  /** Centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'box' | 'circle' | 'pill' | 'dot';
  lines: string[];
  fontSize: number;
  /** Where the text sits relative to the shape (dots on axes carry their label above/below). */
  textAt: 'center' | 'above' | 'below';
  /** Small caption (group, date), shown above the label. */
  caption?: string;
  detail?: string;
}

export interface SceneEdge {
  from: string;
  to: string;
  /** SVG path data. */
  d: string;
  arrow: boolean;
  dashed?: boolean;
  label?: string;
  labelX?: number;
  labelY?: number;
}

export type SceneDecor =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; tone: 'muted' | 'accent' | 'gradient'; width: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; tone: 'muted' | 'accent'; fill: boolean; label?: string; labelX?: number; labelY?: number }
  | { kind: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; tone: 'muted' | 'accent' | 'ink'; weight: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; tone: 'muted' | 'accent' };

export interface Scene {
  template: DiagramTemplate;
  width: number;
  height: number;
  title?: string;
  nodes: SceneNode[];
  edges: SceneEdge[];
  decor: SceneDecor[];
}

// ---------------------------------------------------------------------------------------------
// Text

/** Average glyph width relative to the font size (proportional serif/sans at weight 500–600). */
const GLYPH = 0.54;

/** Greedy word wrap into at most `maxLines` lines of `maxChars`; the last line gets an ellipsis. */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const out = lines.map((l) => (l.length > maxChars ? `${l.slice(0, Math.max(1, maxChars - 1))}…` : l));
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
    return kept;
  }
  return out;
}

/** Largest font size (≤ max, ≥ min) at which `text` fits a w×h box in ≤ 3 lines. */
function fitText(text: string, w: number, h: number, max: number, min = 20): { lines: string[]; fontSize: number } {
  for (let size = max; size >= min; size -= 2) {
    const maxChars = Math.max(4, Math.floor(w / (size * GLYPH)));
    const maxLines = Math.max(1, Math.min(3, Math.floor(h / (size * 1.25))));
    const lines = wrap(text, maxChars, maxLines);
    if (!lines.some((l) => l.endsWith('…'))) return { lines, fontSize: size };
  }
  const maxChars = Math.max(4, Math.floor(w / (min * GLYPH)));
  return { lines: wrap(text, maxChars, Math.max(1, Math.min(3, Math.floor(h / (min * 1.25))))), fontSize: min };
}

// ---------------------------------------------------------------------------------------------
// Helpers

type Item = Diagram['items'][number];

function node(item: Item, x: number, y: number, w: number, h: number, o: Partial<SceneNode> = {}, max = 40): SceneNode {
  const inner = o.shape === 'circle' ? w * 0.72 : w - 28;
  const innerH = o.shape === 'circle' ? h * 0.6 : h - 18;
  const { lines, fontSize } = fitText(item.label, inner, o.textAt && o.textAt !== 'center' ? 120 : innerH, max);
  return {
    id: item.id,
    x,
    y,
    w,
    h,
    shape: 'box',
    lines,
    fontSize,
    textAt: 'center',
    ...(item.detail ? { detail: item.detail } : {}),
    ...o,
  };
}

/** Point where the segment from the centre of `a` towards `(tx, ty)` leaves `a`'s shape. */
function exitPoint(a: SceneNode, tx: number, ty: number, pad = 10): [number, number] {
  const dx = tx - a.x;
  const dy = ty - a.y;
  const len = Math.hypot(dx, dy) || 1;
  if (a.shape === 'circle' || a.shape === 'dot') {
    const r = a.w / 2 + pad;
    return [a.x + (dx / len) * r, a.y + (dy / len) * r];
  }
  const hw = a.w / 2 + pad;
  const hh = a.h / 2 + pad;
  const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return [a.x + dx * s, a.y + dy * s];
}

function straight(a: SceneNode, b: SceneNode, o: Partial<SceneEdge> = {}): SceneEdge {
  const [x1, y1] = exitPoint(a, b.x, b.y);
  const [x2, y2] = exitPoint(b, a.x, a.y, 14);
  return { from: a.id, to: b.id, d: `M${r(x1)} ${r(y1)} L${r(x2)} ${r(y2)}`, arrow: true, labelX: r((x1 + x2) / 2), labelY: r((y1 + y2) / 2 - 14), ...o };
}

const r = (n: number): number => Math.round(n * 10) / 10;

/** Straight when aligned; otherwise an orthogonal elbow through the gap between the two nodes. */
function routed(a: SceneNode, b: SceneNode): SceneEdge {
  if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return straight(a, b);
  const right = b.x > a.x;
  const x1 = a.x + (right ? 1 : -1) * (a.w / 2 + 10);
  const x2 = b.x - (right ? 1 : -1) * (b.w / 2 + 14);
  const mx = (x1 + x2) / 2;
  return { from: a.id, to: b.id, d: `M${r(x1)} ${r(a.y)} H${r(mx)} V${r(b.y)} H${r(x2)}`, arrow: true, labelX: r(mx), labelY: r((a.y + b.y) / 2) };
}

/** Edges given by the diagram, else consecutive items. */
function edgesOrChain(d: Diagram, nodes: Map<string, SceneNode>, make: (a: SceneNode, b: SceneNode) => SceneEdge): SceneEdge[] {
  const pairs = d.edges?.length ? d.edges.map((e) => [e.from, e.to, e.label] as const) : d.items.slice(1).map((it, k) => [d.items[k]!.id, it.id, undefined] as const);
  return pairs.flatMap(([f, t, label]) => {
    const a = nodes.get(f);
    const b = nodes.get(t);
    if (!a || !b || a === b) return [];
    const e = make(a, b);
    return [label ? { ...e, label } : e];
  });
}

const byId = (nodes: SceneNode[]): Map<string, SceneNode> => new Map(nodes.map((n) => [n.id, n]));

/** Top of the drawing area (below an optional title). */
const top = (d: Diagram): number => (d.title ? 150 : MARGIN);

// ---------------------------------------------------------------------------------------------
// Templates

function rowFlow(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const rows = n <= 5 ? 1 : 2;
  const perRow = Math.ceil(n / rows);
  const areaTop = top(d);
  const areaH = SCENE_HEIGHT - areaTop - MARGIN;
  const gap = 70;
  const w = Math.min(300, (SCENE_WIDTH - 2 * MARGIN - gap * (perRow - 1)) / perRow);
  const h = Math.min(190, (areaH - (rows - 1) * 90) / rows);
  const nodes = d.items.map((item, k) => {
    const row = Math.floor(k / perRow);
    const col = k % perRow;
    // Second row runs right to left so the flow snakes on.
    const c = row % 2 === 0 ? col : perRow - 1 - col;
    const inRow = row === rows - 1 ? n - row * perRow : perRow;
    const offset = row % 2 === 0 ? (perRow - inRow) * (w + gap) / 2 : -(perRow - inRow) * (w + gap) / 2;
    const totalW = perRow * w + (perRow - 1) * gap;
    const x = (SCENE_WIDTH - totalW) / 2 + w / 2 + c * (w + gap) + offset;
    const y = areaTop + areaH / (rows * 2) + row * (areaH / rows);
    return node(item, x, y, w, h);
  });
  const map = byId(nodes);
  return { nodes, edges: edgesOrChain(d, map, (a, b) => straight(a, b)), decor: [] };
}

function columnFlow(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const cols = n <= 5 ? 1 : 2;
  const perCol = Math.ceil(n / cols);
  const areaTop = top(d);
  const areaH = SCENE_HEIGHT - areaTop - MARGIN;
  const gapY = 46;
  const h = Math.min(120, (areaH - gapY * (perCol - 1)) / perCol);
  const w = cols === 1 ? 760 : 620;
  const nodes = d.items.map((item, k) => {
    const col = Math.floor(k / perCol);
    const row = k % perCol;
    const x = cols === 1 ? SCENE_WIDTH / 2 : SCENE_WIDTH / 2 + (col === 0 ? -1 : 1) * (w / 2 + 50);
    const totalH = perCol * h + (perCol - 1) * gapY;
    const y = areaTop + (areaH - totalH) / 2 + h / 2 + row * (h + gapY);
    return node(item, x, y, w, h, {}, 38);
  });
  return { nodes, edges: edgesOrChain(d, byId(nodes), routed), decor: [] };
}

function timeline(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const y = (top(d) + SCENE_HEIGHT) / 2 + 10;
  const x0 = MARGIN + 80;
  const x1 = SCENE_WIDTH - MARGIN - 80;
  const step = n > 1 ? (x1 - x0) / (n - 1) : 0;
  const labelW = Math.min(300, Math.max(160, step * 1.6));
  const nodes = d.items.map((item, k) => {
    const above = k % 2 === 0;
    const x = n > 1 ? x0 + k * step : SCENE_WIDTH / 2;
    return node(item, x, y, 26, 26, { shape: 'dot', textAt: above ? 'above' : 'below', ...(item.group ? { caption: item.group } : {}), w: 26, h: 26 }, 30);
  }).map((nd) => ({ ...nd, ...fitText(d.items.find((i) => i.id === nd.id)!.label, labelW, 110, 30) }));
  return {
    nodes,
    edges: [],
    decor: [{ kind: 'line', x1: x0 - 50, y1: y, x2: x1 + 50, y2: y, tone: 'muted', width: 4 }],
  };
}

function cycle(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const cy = (top(d) + SCENE_HEIGHT) / 2;
  const R = Math.min(330, (SCENE_HEIGHT - top(d) - MARGIN) / 2 - 70);
  const cx = SCENE_WIDTH / 2;
  const w = Math.min(320, Math.max(200, (2 * Math.PI * R) / n - 30));
  const h = 104;
  const angle = (k: number): number => -Math.PI / 2 + (2 * Math.PI * k) / n;
  const nodes = d.items.map((item, k) => node(item, cx + Math.cos(angle(k)) * R * 1.45, cy + Math.sin(angle(k)) * R, w, h, { shape: 'pill' }, 34));
  // Arcs along the ring between consecutive items.
  const edges: SceneEdge[] = d.items.map((item, k) => {
    const next = d.items[(k + 1) % n]!;
    const a0 = angle(k) + Math.PI / n / 1.6;
    const a1 = angle(k + 1) - Math.PI / n / 1.6;
    const p = (a: number): string => `${r(cx + Math.cos(a) * R * 1.45)} ${r(cy + Math.sin(a) * R)}`;
    return { from: item.id, to: next.id, d: `M${p(a0)} A${r(R * 1.45)} ${r(R)} 0 0 1 ${p(a1)}`, arrow: true };
  });
  return { nodes, edges: n > 1 ? edges : [], decor: [] };
}

function spectrum(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const y = (top(d) + SCENE_HEIGHT) / 2 + 20;
  // Middle items sit between the poles' inner edges; labels alternate above/below the axis, so
  // labels on the same side are two steps apart.
  const m = n - 2;
  const inner0 = MARGIN + 310;
  const inner1 = SCENE_WIDTH - MARGIN - 310;
  const lw = m <= 1 ? 300 : Math.min(260, Math.max(140, ((inner1 - inner0) / m) * 1.8));
  const nodes: SceneNode[] = d.items.map((item, k) => {
    if (k === 0 || k === n - 1) {
      const x = k === 0 ? MARGIN + 150 : SCENE_WIDTH - MARGIN - 150;
      return node(item, x, y, 280, 120, { shape: 'pill' }, 38);
    }
    const a = inner0 + lw / 2;
    const b = inner1 - lw / 2;
    const x = m === 1 ? SCENE_WIDTH / 2 : a + ((b - a) * (k - 1)) / (m - 1);
    return { ...node(item, x, y, 24, 24, { shape: 'dot', textAt: k % 2 ? 'above' : 'below' }), ...fitText(item.label, lw, 110, 30) };
  });
  return {
    nodes,
    edges: [],
    decor: [{ kind: 'line', x1: MARGIN + 290, y1: y, x2: SCENE_WIDTH - MARGIN - 290, y2: y, tone: 'gradient', width: 8 }],
  };
}

/** Groups in order of first appearance (null → `fallback`). */
function groupsOf(d: Diagram, fallback: (k: number) => string): string[] {
  const out: string[] = [];
  for (const [k, i] of d.items.entries()) {
    const g = i.group ?? fallback(k);
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

function comparison(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const half = Math.ceil(d.items.length / 2);
  const groupOf = (i: Item, k: number): string => i.group ?? (k < half ? '1' : '2');
  const groups = groupsOf(d, (k) => (k < half ? '1' : '2')).slice(0, 4);
  const colW = (SCENE_WIDTH - 2 * MARGIN - (groups.length - 1) * 50) / groups.length;
  const headerY = top(d) + 30;
  const areaTop = headerY + 60;
  const maxRows = Math.max(...groups.map((g) => d.items.filter((i, k) => groupOf(i, k) === g).length));
  const h = Math.min(130, (SCENE_HEIGHT - MARGIN - areaTop - (maxRows - 1) * 24) / maxRows);
  const decor: SceneDecor[] = [];
  const nodes: SceneNode[] = [];
  for (const [c, g] of groups.entries()) {
    const x = MARGIN + colW / 2 + c * (colW + 50);
    if (d.items.some((i) => i.group)) decor.push({ kind: 'text', x, y: headerY, text: g, size: 34, anchor: 'middle', tone: 'accent', weight: 700 });
    if (c > 0) decor.push({ kind: 'line', x1: x - colW / 2 - 25, y1: areaTop - 20, x2: x - colW / 2 - 25, y2: SCENE_HEIGHT - MARGIN, tone: 'muted', width: 2 });
    d.items
      .filter((i, k) => groupOf(i, k) === g)
      .forEach((item, row) => nodes.push(node(item, x, areaTop + h / 2 + row * (h + 24), Math.min(colW, 560), h, {}, 34)));
  }
  return { nodes, edges: [], decor };
}

function hierarchy(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const ids = d.items.map((i) => i.id);
  const edges = d.edges?.length ? d.edges.filter((e) => ids.includes(e.from) && ids.includes(e.to)) : d.items.slice(1).map((i) => ({ from: d.items[0]!.id, to: i.id }));
  const parent = new Map<string, string>();
  for (const e of edges) if (!parent.has(e.to) && e.to !== e.from) parent.set(e.to, e.from);
  const depth = (id: string, seen = new Set<string>()): number => {
    const p = parent.get(id);
    if (!p || seen.has(id)) return 0;
    seen.add(id);
    return 1 + depth(p, seen);
  };
  const levels: string[][] = [];
  for (const id of ids) (levels[depth(id)] ??= []).push(id);
  const areaTop = top(d);
  const levelH = (SCENE_HEIGHT - areaTop - MARGIN) / levels.length;
  const h = Math.min(120, levelH - 60);
  const nodes: SceneNode[] = [];
  for (const [l, row] of levels.entries()) {
    const w = Math.min(340, (SCENE_WIDTH - 2 * MARGIN - (row.length - 1) * 30) / row.length);
    row.forEach((id, k) => {
      const item = d.items.find((i) => i.id === id)!;
      const x = MARGIN + ((SCENE_WIDTH - 2 * MARGIN) * (k + 0.5)) / row.length;
      nodes.push(node(item, x, areaTop + levelH * (l + 0.5), w, h, {}, 34));
    });
  }
  const map = byId(nodes);
  const sceneEdges = [...parent.entries()].flatMap(([child, p]) => {
    const a = map.get(p);
    const b = map.get(child);
    if (!a || !b) return [];
    const y1 = a.y + a.h / 2 + 8;
    const y2 = b.y - b.h / 2 - 12;
    const my = (y1 + y2) / 2;
    return [{ from: p, to: child, d: `M${r(a.x)} ${r(y1)} C${r(a.x)} ${r(my)} ${r(b.x)} ${r(my)} ${r(b.x)} ${r(y2)}`, arrow: true }];
  });
  return { nodes, edges: sceneEdges, decor: [] };
}

function matrix(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const areaTop = top(d);
  const cx = SCENE_WIDTH / 2;
  const cy = (areaTop + SCENE_HEIGHT - MARGIN) / 2;
  const cellW = 560;
  const cellH = (SCENE_HEIGHT - areaTop - MARGIN - 30) / 2;
  const nodes = d.items.slice(0, 4).map((item, k) => {
    const x = cx + (k % 2 === 0 ? -1 : 1) * (cellW / 2 + 15);
    const y = cy + (k < 2 ? -1 : 1) * (cellH / 2 + 15);
    return node(item, x, y, cellW, cellH, { ...(item.group ? { caption: item.group } : {}) }, 38);
  });
  return {
    nodes,
    edges: [],
    decor: [
      { kind: 'line', x1: cx, y1: areaTop, x2: cx, y2: SCENE_HEIGHT - MARGIN, tone: 'muted', width: 3 },
      { kind: 'line', x1: cx - cellW - 40, y1: cy, x2: cx + cellW + 40, y2: cy, tone: 'muted', width: 3 },
    ],
  };
}

function venn(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  let sets = d.items.filter((i) => !i.group);
  if (sets.length < 2 || sets.length > 3) sets = d.items.slice(0, Math.min(3, Math.max(2, d.items.length)));
  const members = d.items.filter((i) => !sets.includes(i));
  const areaTop = top(d);
  const cy = (areaTop + SCENE_HEIGHT - MARGIN) / 2 + (sets.length === 3 ? 20 : 0);
  const R = Math.min(300, (SCENE_HEIGHT - areaTop - MARGIN) / (sets.length === 3 ? 2.6 : 2));
  const cx = SCENE_WIDTH / 2;
  const centres: Array<[number, number]> =
    sets.length === 2
      ? [
          [cx - R * 0.62, cy],
          [cx + R * 0.62, cy],
        ]
      : [
          [cx - R * 0.6, cy + R * 0.35],
          [cx + R * 0.6, cy + R * 0.35],
          [cx, cy - R * 0.62],
        ];
  const decor: SceneDecor[] = sets.map((s, k) => ({ kind: 'circle', cx: centres[k]![0], cy: centres[k]![1], r: R, tone: k === 0 ? 'accent' : 'muted', fill: true }));
  // Unit direction from the diagram centre to each set's centre: its exclusive area lies that way.
  const dir = centres.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len] as const;
  });
  // Set names at the outer rim of their circle (top for upper/side circles, bottom for lower ones).
  const nodes: SceneNode[] = sets.map((set, k) => {
    const [x, y] = centres[k]!;
    const below = sets.length === 3 && k < 2;
    const lx = Math.min(SCENE_WIDTH - MARGIN - 140, Math.max(MARGIN + 140, x + dir[k]![0] * R * 0.38));
    const ly = Math.min(SCENE_HEIGHT - MARGIN - 40, Math.max(areaTop + 40, y + (below ? 1 : -1) * R * 0.7));
    return node(set, lx, ly, 250, 66, { shape: 'pill' }, 32);
  });
  const setIndex = new Map(sets.map((x, k) => [x.id, k]));
  const placeOf = (m: Item): number[] => {
    const ks = (m.group ?? '')
      .split('+')
      .map((g) => g.trim())
      .map((g) => setIndex.get(g) ?? sets.findIndex((x) => x.label === g))
      .filter((k) => k >= 0);
    return ks.length ? [...new Set(ks)].sort() : sets.map((_, k) => k);
  };
  const groups = new Map<string, Item[]>();
  for (const m of members) {
    const key = placeOf(m).join('+');
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const rowH = 70;
  for (const [key, list] of groups) {
    const use = key.split('+').map(Number);
    let x = use.reduce((acc, k) => acc + centres[k]![0], 0) / use.length;
    let y = use.reduce((acc, k) => acc + centres[k]![1], 0) / use.length;
    if (use.length === 1) {
      const k = use[0]!;
      x = centres[k]![0] + dir[k]![0] * R * 0.42;
      y = centres[k]![1] + dir[k]![1] * R * 0.25;
    }
    const w = use.length > 1 ? 210 : 250;
    list.forEach((m, j) => nodes.push(node(m, x, y + (j - (list.length - 1) / 2) * rowH, w, 58, {}, 26)));
  }
  return { nodes, edges: [], decor };
}

function network(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const n = d.items.length;
  const cx = SCENE_WIDTH / 2;
  const cy = (top(d) + SCENE_HEIGHT) / 2;
  const R = (SCENE_HEIGHT - top(d) - MARGIN) / 2 - 70;
  const nodes = d.items.map((item, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return node(item, cx + Math.cos(a) * R * 1.7, cy + Math.sin(a) * R, 250, 96, { shape: 'pill' }, 32);
  });
  const map = byId(nodes);
  const edges = (d.edges ?? []).flatMap((e) => {
    const a = map.get(e.from);
    const b = map.get(e.to);
    return a && b && a !== b ? [straight(a, b, { arrow: false, ...(e.label ? { label: e.label } : {}) })] : [];
  });
  return { nodes, edges, decor: [] };
}

function equation(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const half = Math.ceil(d.items.length / 2);
  const left = d.items.filter((i, k) => (i.group ? i.group.toLowerCase() === 'left' : k < half));
  const right = d.items.filter((i) => !left.includes(i));
  const rows = Math.max(left.length, right.length, 1);
  const areaTop = top(d);
  const h = Math.min(130, (SCENE_HEIGHT - areaTop - MARGIN - (rows - 1) * 30) / rows);
  const y = (k: number): number => areaTop + (SCENE_HEIGHT - areaTop - MARGIN - rows * h - (rows - 1) * 30) / 2 + h / 2 + k * (h + 30);
  const w = 560;
  const lx = SCENE_WIDTH / 2 - w / 2 - 110;
  const rx = SCENE_WIDTH / 2 + w / 2 + 110;
  const nodes = [...left.map((i, k) => node(i, lx, y(k), w, h, {}, 36)), ...right.map((i, k) => node(i, rx, y(k), w, h, {}, 36))];
  const map = byId(nodes);
  const edges: SceneEdge[] = left.flatMap((l, k) => {
    const rItem = right[k];
    const a = map.get(l.id);
    const b = rItem ? map.get(rItem.id) : undefined;
    return a && b ? [{ ...straight(a, b, { arrow: false, dashed: true }) }] : [];
  });
  return {
    nodes,
    edges,
    decor: [{ kind: 'text', x: SCENE_WIDTH / 2, y: (areaTop + SCENE_HEIGHT - MARGIN) / 2 + 30, text: '⇄', size: 96, anchor: 'middle', tone: 'accent', weight: 400 }],
  };
}

function list(d: Diagram): Pick<Scene, 'nodes' | 'edges' | 'decor'> {
  const flow = columnFlow({ ...d, edges: [] });
  return { ...flow, edges: [] };
}

const LAYOUTS: Record<DiagramTemplate, (d: Diagram) => Pick<Scene, 'nodes' | 'edges' | 'decor'>> = {
  list,
  process: rowFlow,
  'causal-chain': columnFlow,
  timeline,
  cycle,
  spectrum,
  comparison,
  hierarchy,
  matrix,
  venn,
  network,
  equation,
};

/** Templates and how many items each lays out well. */
const LIMITS: Record<DiagramTemplate, [number, number]> = {
  list: [1, 10],
  process: [2, 10],
  'causal-chain': [2, 10],
  timeline: [2, 10],
  cycle: [3, 8],
  spectrum: [2, 7],
  comparison: [2, 10],
  hierarchy: [2, 10],
  matrix: [4, 4],
  venn: [2, 9],
  network: [3, 9],
  equation: [2, 8],
};

/** The template actually used: the requested one if its item count fits, else `list`. */
export function effectiveTemplate(d: Diagram): DiagramTemplate {
  const [min, max] = LIMITS[d.template];
  return d.items.length >= min && d.items.length <= max ? d.template : 'list';
}

/** Lays out a diagram (pure, deterministic). */
export function layoutDiagram(d: Diagram): Scene {
  const template = effectiveTemplate(d);
  const parts = LAYOUTS[template]({ ...d, template });
  const decor: SceneDecor[] = [...parts.decor];
  return { template, width: SCENE_WIDTH, height: SCENE_HEIGHT, ...(d.title ? { title: d.title } : {}), nodes: parts.nodes, edges: parts.edges, decor };
}

const cache = new WeakMap<Diagram, Scene>();

/** `layoutDiagram`, cached per diagram object (plans are immutable). */
export function sceneFor(d: Diagram): Scene {
  let s = cache.get(d);
  if (!s) {
    s = layoutDiagram(d);
    cache.set(d, s);
  }
  return s;
}
