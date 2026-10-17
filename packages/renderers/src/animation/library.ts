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
  var root = document.getElementById('scene');
  var state = { motion: 'full', cues: [], items: [], terms: [], palette: {} };

  function fmt(v) { return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v); }
  function handle(el) {
    var h = {
      el: el,
      set: function (attrs) {
        for (var k in attrs) {
          if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
          var v = attrs[k];
          if (k === 'text') el.textContent = String(v);
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
      var size = Math.max(22, (a && a['font-size']) || 40);
      var h = make('text', Object.assign({ 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: state.palette.ink }, a, { 'font-size': size }), p);
      h.set({ text: str });
      return h;
    },
    /** Wrapped text in a rounded box: lb.label('Mentalism', { x, y, w, size, fill, color }). */
    label: function (str, a, p) {
      a = a || {};
      var size = Math.max(22, a.size || 34);
      var w = a.w || 320;
      var maxChars = Math.max(4, Math.floor((w - 24) / (size * 0.54)));
      var words = String(str).split(/\s+/), lines = [], line = '';
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
      return g;
    },
  };

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
        if (typeof window.__lbProgram !== 'function') throw new Error('program did not load (syntax error?)');
        update = window.__lbProgram(lb);
        if (typeof update !== 'function') throw new Error('program must return a function (t) => { … }');
        update(0);
        send({ type: 'ready' });
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
    '<svg id="scene" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet"><defs><marker id="lb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs></svg>',
    `<script>${LIBRARY_SOURCE}</script>`,
    `<script>window.__lbProgram = function (lb) {\n${safe}\n};</script>`,
    '</body></html>',
  ].join('');
}
