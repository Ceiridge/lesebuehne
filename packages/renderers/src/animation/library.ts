export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fit of a scene that leaves the canvas (spec 007 B3): scale (never up) and shift so the box lies
 * inside the canvas with `margin`; null when the box is already inside the canvas. Self-contained
 * (its source is embedded in the sandbox library).
 */
export function fitTransform(box: Box | null, w: number, h: number, margin: number): { s: number; tx: number; ty: number } | null {
  if (!box || !(box.width > 0 || box.height > 0)) return null;
  if (box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h) return null;
  const s = Math.min(1, (w - 2 * margin) / Math.max(box.width, 1), (h - 2 * margin) / Math.max(box.height, 1));
  const x0 = box.x * s;
  const y0 = box.y * s;
  const x1 = (box.x + box.width) * s;
  const y1 = (box.y + box.height) * s;
  const tx = x0 < margin ? margin - x0 : x1 > w - margin ? w - margin - x1 : 0;
  const ty = y0 < margin ? margin - y0 : y1 > h - margin ? h - margin - y1 : 0;
  return { s, tx, ty };
}

/** Longest string `lb.text` shows; longer ones end with "…". */
export const MAX_TEXT_CHARS = 32;
export const MAX_TEXT_ELEMENTS = 3;

/**
 * Source of the `lb` animation library and the sandbox runtime (spec 003 B3, B4). Plain ES2020
 * that runs only inside the sandboxed iframe; kept as a string so it can be inlined in `srcdoc`.
 * The API documented in the director's animate prompt must match this file.
 */
export const LIBRARY_SOURCE = String.raw`
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var W = 1600, H = 900;
  var root = document.getElementById('lb-fit') || document.getElementById('scene');
  var fitTransform = (` + fitTransform.toString() + String.raw`);
  var state = { motion: 'full', cues: [], items: [], terms: [], palette: {} };
  var textElements = 0;

  function fmt(v) { return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v); }
  function shortText(v) {
    var words = String(v).trim().split(/\s+/);
    var chars = Array.from(words.slice(0, 3).join(' '));
    var truncated = words.length > 3 || chars.length > ${MAX_TEXT_CHARS};
    return truncated ? chars.slice(0, ${MAX_TEXT_CHARS - 1}).join('').replace(/\s+$/, '') + '…' : chars.join('');
  }
  function handle(el) {
    var h = {
      el: el,
      set: function (attrs) {
        for (var k in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
          var v = attrs[k];
          if (k === 'text') el.textContent = shortText(v);
          else if (v === null || v === undefined || v === false) el.removeAttribute(k);
          else el.setAttribute(k, fmt(v));
        }
        return h;
      },
      show: function (on) { el.style.display = on ? '' : 'none'; return h; },
    };
    return h;
  }
  function make(tag, attrs, parent) {
    if (tag === 'text' && ++textElements > ${MAX_TEXT_ELEMENTS}) throw new Error('Too much text: use at most three short labels total. Explain the idea with shapes and motion instead.');
    var el = document.createElementNS(NS, tag);
    (parent && parent.el ? parent.el : root).appendChild(el);
    return handle(el).set(attrs || {});
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  var ease = {
    linear: function (p) { return p; },
    in: function (p) { return p * p; },
    out: function (p) { return 1 - (1 - p) * (1 - p); },
    inOut: function (p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; },
  };

  var lb = {
    W: W, H: H,
    get motion() { return state.motion; },
    get palette() { return state.palette; },
    get items() { return state.items; },
    get terms() { return state.terms; },
    /** Seconds (section time) of cue i; Infinity if there is none. */
    cue: function (i) { var c = state.cues[i]; return typeof c === 'number' ? c : Infinity; },
    get cueCount() { return state.cues.length; },
    clamp: clamp,
    lerp: function (a, b, p) { return a + (b - a) * p; },
    ease: ease,
    /** Progress 0…1 of a segment starting at start (s) lasting dur (s); eased; steps without motion. */
    seg: function (t, start, dur, fn) {
      if (state.motion === 'none') return t >= start + (dur || 0) ? 1 : 0;
      var p = dur > 0 ? clamp((t - start) / dur, 0, 1) : t >= start ? 1 : 0;
      return (fn || ease.inOut)(p);
    },
    /** Point on a circle; angle in degrees, 0 = right, clockwise. */
    polar: function (cx, cy, r, deg) { var a = (deg * Math.PI) / 180; return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }; },
    /** Deterministic pseudo-random generator: var rnd = lb.random(7); rnd() → 0…1. */
    random: function (seed) {
      var s = (seed >>> 0) || 1;
      return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    },
    group: function (a, p) { return make('g', a, p); },
    circle: function (a, p) { return make('circle', Object.assign({ fill: state.palette.accent }, a), p); },
    rect: function (a, p) { return make('rect', Object.assign({ fill: state.palette.accent }, a), p); },
    ellipse: function (a, p) { return make('ellipse', Object.assign({ fill: state.palette.accent }, a), p); },
    line: function (a, p) { return make('line', Object.assign({ stroke: state.palette.ink, 'stroke-width': 4, 'stroke-linecap': 'round' }, a), p); },
    path: function (a, p) { return make('path', Object.assign({ fill: 'none', stroke: state.palette.ink, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, a), p); },
    polygon: function (a, p) { return make('polygon', Object.assign({ fill: state.palette.accent }, a), p); },
    /** Line with an arrowhead at its end. */
    arrow: function (a, p) { return make('line', Object.assign({ stroke: state.palette.ink, 'stroke-width': 4, 'stroke-linecap': 'round', 'marker-end': 'url(#lb-arrow)' }, a), p); },
    text: function (str, a, p) {
      var size = Math.max(40, (a && a['font-size']) || 52);
      var h = make('text', Object.assign({ 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: state.palette.ink }, a, { 'font-size': size }), p);
      h.set({ text: str });
      return h;
    },
    /** Wrapped text in a rounded box: lb.label('Mentalism', { x, y, w, size, fill, color }). */
    label: function (str, a, p) {
      a = a || {};
      var size = Math.max(40, a.size || 52);
      var w = a.w || 320;
      var maxChars = Math.max(4, Math.floor((w - 24) / (size * 0.54)));
      var words = shortText(str).split(/\s+/), lines = [], line = '';
      for (var i = 0; i < words.length; i++) {
        var next = line ? line + ' ' + words[i] : words[i];
        if (next.length <= maxChars || !line) line = next; else { lines.push(line); line = words[i]; }
      }
      if (line) lines.push(line);
      lines = lines.slice(0, 3);
      var h = lines.length * size * 1.22 + 26;
      var g = make('g', { transform: 'translate(' + fmt(a.x || 0) + ' ' + fmt(a.y || 0) + ')' }, p);
      make('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 16, fill: a.fill || state.palette.background, stroke: a.color || state.palette.accent, 'stroke-width': 3 }, g);
      var t = make('text', { 'text-anchor': 'middle', 'font-size': size, fill: state.palette.ink, 'font-weight': 600 }, g);
      for (var k = 0; k < lines.length; k++) {
        var span = document.createElementNS(NS, 'tspan');
        span.setAttribute('x', '0');
        span.setAttribute('y', fmt(-h / 2 + 13 + size * 0.95 + k * size * 1.22));
        span.textContent = lines[k];
        t.el.appendChild(span);
      }
      g.width = w; g.height = h;
      var set = g.set;
      g.set = function (attrs) {
        var rest = {};
        for (var key in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
          if (key === 'text') {
            // Keep the box intact. Updated captions are one short line, not a new scene.
            t.el.textContent = shortText(attrs[key]);
            t.el.setAttribute('y', String(size * 0.35));
          } else rest[key] = attrs[key];
        }
        return set(rest);
      };
      return g;
    },
  };

  /** Samples the program at its key moments; scales/shifts the scene once if it leaves the canvas. */
  function fitScene() {
    var times = [0];
    for (var i = 0; i < state.cues.length && i < 24; i++) {
      var c = state.cues[i];
      if (typeof c === 'number' && isFinite(c)) times.push(c + 1.5);
    }
    times.push(times[times.length - 1] + 6);
    var box = null;
    for (var k = 0; k < times.length; k++) {
      update(times[k]);
      var b = root.getBBox();
      if (!(b.width > 0 || b.height > 0)) continue;
      if (!box) box = { x: b.x, y: b.y, width: b.width, height: b.height };
      else {
        var x1 = Math.max(box.x + box.width, b.x + b.width), y1 = Math.max(box.y + box.height, b.y + b.height);
        box.x = Math.min(box.x, b.x); box.y = Math.min(box.y, b.y);
        box.width = x1 - box.x; box.height = y1 - box.y;
      }
    }
    update(0);
    var f = fitTransform(box, W, H, 24);
    if (f && root.id === 'lb-fit') root.setAttribute('transform', 'translate(' + f.tx + ' ' + f.ty + ') scale(' + f.s + ')');
    return f;
  }

  var update = null;
  var nonce = '';
  function send(msg) { msg.nonce = nonce; parent.postMessage(msg, '*'); }
  window.addEventListener('error', function (e) { send({ type: 'error', message: String(e.message || e) }); });
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (e.source !== parent) return;
    if (m.type === 'init') {
      nonce = String(m.nonce || '');
      state.motion = m.motion || 'full';
      state.cues = m.cues || [];
      state.items = m.items || [];
      state.terms = m.terms || [];
      state.palette = m.palette || {};
      document.documentElement.style.background = 'transparent';
      try {
        textElements = 0;
        root.replaceChildren();
        if (typeof window.__lbProgram !== 'function') throw new Error('program did not load (syntax error?)');
        update = window.__lbProgram(lb);
        if (typeof update !== 'function') throw new Error('program must return a function (t) => { … }');
        update(0);
        var fit = null;
        try { fit = fitScene(); } catch (e) { /* measuring is best effort */ }
        finally { update(0); }
        send(fit ? { type: 'ready', fit: fit } : { type: 'ready' });
      } catch (err) {
        send({ type: 'error', message: String(err && err.message || err) });
      }
    } else if (m.type === 'seek' && update) {
      try { update(Number(m.t) || 0); send({ type: 'tick', t: m.t }); }
      catch (err) { update = null; send({ type: 'error', message: String(err && err.message || err) }); }
    }
  });
  window.__lb = lb;
})();
`;

/** Content-Security-Policy of the sandbox document: no network, no external anything. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The iframe document: library, then the program (as an inline function), nothing else. */
export function sandboxDocument(code: string): string {
  // The program is pasted inside a <script>; "</" cannot end it early once escaped.
  const safe = code.replace(/<\//gu, '<\\/');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<style>:root{color-scheme:light dark}html,body{margin:0;height:100%;overflow:hidden;background:transparent}svg{width:100%;height:100%;display:block;font-family:Georgia,"Times New Roman",serif}</style>',
    '</head><body>',
    '<svg id="scene" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet"><defs><marker id="lb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs><g id="lb-fit"></g></svg>',
    `<script>${LIBRARY_SOURCE}</script>`,
    `<script>window.__lbProgram = function (lb) {\n${safe}\n};</script>`,
    '</body></html>',
  ].join('');
}
