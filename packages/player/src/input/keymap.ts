/** Reader actions reachable by keyboard (B8). */
export type Action =
  | 'toggle-play'
  | 'prev-sentence'
  | 'next-sentence'
  | 'prev-section'
  | 'next-section'
  | 'prev-paragraph'
  | 'next-paragraph'
  | 'tempo-down'
  | 'tempo-up'
  | 'cycle-visual'
  | 'toggle-text-mode'
  | 'toggle-subtitles'
  | 'open-toc'
  | 'toggle-bookmark'
  | 'toggle-debug'
  | 'regenerate'
  | 'open-help'
  | 'close';

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What has focus, as far as key handling is concerned. */
export type FocusKind = 'text-input' | 'button' | 'link' | 'slider' | 'other';

export interface KeyContext {
  focus: FocusKind;
  /** A modal panel is open: only Esc (and the panel's own keys, which it handles) work. */
  modalOpen: boolean;
}

/** Characters that may come with AltGr/Shift (QWERTZ) and still map (C10). */
const CHARACTER_KEYS: Readonly<Record<string, Action>> = {
  '[': 'tempo-down',
  '-': 'tempo-down',
  ']': 'tempo-up',
  '+': 'tempo-up',
  '?': 'open-help',
};

const LETTERS: Readonly<Record<string, Action>> = {
  v: 'cycle-visual',
  t: 'toggle-text-mode',
  s: 'toggle-subtitles',
  m: 'open-toc',
  b: 'toggle-bookmark',
  d: 'toggle-debug',
  r: 'regenerate',
  k: 'prev-paragraph',
  j: 'next-paragraph',
};

/**
 * Maps a key event to a reader action (B8, C10), or `null` to leave it to the browser:
 * matches `event.key` (the produced character); letters case-insensitive; Ctrl/Meta/Alt only when
 * they produce one of the mapped characters (AltGr); nothing while typing in a text field;
 * Space/Enter stay native on buttons and links, arrows on sliders; with a modal open only Esc.
 */
export function mapKey(e: KeyLike, ctx: KeyContext): Action | null {
  if (ctx.focus === 'text-input') return null;
  if (e.key === 'Escape') return 'close';
  if (ctx.modalOpen) return null;
  const character = CHARACTER_KEYS[e.key];
  if (character) return character;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      return ctx.focus === 'button' || ctx.focus === 'link' ? null : 'toggle-play';
    case 'ArrowLeft':
      return ctx.focus === 'slider' ? null : e.shiftKey ? 'prev-section' : 'prev-sentence';
    case 'ArrowRight':
      return ctx.focus === 'slider' ? null : e.shiftKey ? 'next-section' : 'next-sentence';
    case 'ArrowUp':
      return ctx.focus === 'slider' ? null : 'prev-paragraph';
    case 'ArrowDown':
      return ctx.focus === 'slider' ? null : 'next-paragraph';
    default:
      return e.key.length === 1 ? (LETTERS[e.key.toLowerCase()] ?? null) : null;
  }
}

/** Focus kind of a DOM element (used with `document.activeElement`). */
export function focusKind(el: Element | null): FocusKind {
  if (!el) return 'other';
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') return 'text-input';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'range') return 'slider';
    if (['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)) return 'button';
    return 'text-input';
  }
  const role = el.getAttribute('role');
  if (role === 'slider') return 'slider';
  if (tag === 'button' || role === 'button' || role === 'radio' || role === 'tab') return 'button';
  if (tag === 'a') return 'link';
  return 'other';
}
