/** F11 has no standard event: desktop browser chrome and screen bounds are a fallback. */
export function browserFullscreen(doc: Document = document, win: Window = window): boolean {
  if (doc.fullscreenElement || win.matchMedia('(display-mode: fullscreen)').matches) return true;
  return win.matchMedia('(hover: hover) and (pointer: fine)').matches
    && win.screen.height > 0 && win.screen.width > 0
    && Math.abs(win.innerHeight - win.screen.height) <= 8
    && Math.abs(win.innerWidth - win.screen.width) <= 8
    && Math.abs(win.outerHeight - win.innerHeight) <= 8;
}
