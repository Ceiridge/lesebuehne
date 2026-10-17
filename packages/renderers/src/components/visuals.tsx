import type { DiagramTemplate } from '@lesebuehne/core';
import type { ItemState, TermState, VisualState } from '../state/visual-state.ts';

/** List diagram: items appear one by one at their cue; the newest one is marked. */
export function ListDiagram({ title, items, template = 'list' }: { title?: string; items: ItemState[]; template?: DiagramTemplate }) {
  return (
    <figure class={`lb-visual lb-list lb-template-${template}`} aria-hidden="true">
      {title ? <figcaption class="lb-list-title">{title}</figcaption> : null}
      <ol class="lb-list-items">
        {items.map((item, k) => (
          <li
            key={item.id}
            class={item.current ? 'lb-list-item is-current' : 'lb-list-item'}
            style={{
              opacity: item.opacity,
              transform: `translateY(${item.offsetY.toFixed(2)}px)`,
              ...(item.color ? { '--lb-concept': item.color } : {}),
            }}
          >
            <span class="lb-list-index">{item.glyph ?? k + 1}</span>
            <span class="lb-list-text">
              {item.group ? <span class="lb-list-group">{item.group}</span> : null}
              <span class="lb-list-label">{item.label}</span>
              {item.detail ? <span class="lb-list-detail">{item.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

/** A central sentence of the section, verbatim, as a pull quote. */
export function QuoteCard({ text, opacity }: { text: string; opacity: number }) {
  return (
    <blockquote class="lb-visual lb-quote" aria-hidden="true" style={{ opacity }}>
      <span class="lb-quote-mark">“</span>
      <span class="lb-quote-text">{text}</span>
    </blockquote>
  );
}

/** Kinetic typography: key terms rise in at their cue; older terms recede. */
export function KineticType({ terms }: { terms: TermState[] }) {
  return (
    <div class="lb-visual lb-kinetic" aria-hidden="true">
      {terms.map((t, k) => (
        <span
          key={`${k}-${t.term}`}
          class={t.current ? 'lb-term is-current' : 'lb-term'}
          style={{
            opacity: t.opacity,
            transform: `translateY(${t.offsetY.toFixed(2)}px) scale(${t.scale.toFixed(3)})`,
            ...(t.color ? { '--lb-concept': t.color } : {}),
          }}
        >
          {t.glyph ? <span class="lb-term-glyph">{t.glyph}</span> : null}
          {t.term}
        </span>
      ))}
    </div>
  );
}

/** A calm title card: the heading the section belongs to (shown when a section has no visual). */
export function TitleCard({ title }: { title?: string | undefined }) {
  if (!title) return <div class="lb-visual lb-none" aria-hidden="true" />;
  return (
    <div class="lb-visual lb-title-card" aria-hidden="true">
      <span class="lb-title-rule" />
      <span class="lb-title-text">{title}</span>
      <span class="lb-title-rule" />
    </div>
  );
}

/** One visual state; "none" shows the section's heading as a title card. */
export function Visual({ state, title }: { state: VisualState; title?: string | undefined }) {
  if (state.mode === 'list') return <ListDiagram {...(state.title ? { title: state.title } : {})} items={state.items} template={state.template} />;
  if (state.mode === 'quote') return <QuoteCard text={state.text} opacity={state.opacity} />;
  // Before the first key term is spoken the stage shows where we are, not an empty canvas.
  if (state.mode === 'kinetic' && state.terms.length > 0) return <KineticType terms={state.terms} />;
  return <TitleCard title={title} />;
}

/** The stage: current visual over the fading previous one (crossfade, B9). */
export function StageView({
  current,
  previous,
  fade,
  currentTitle,
  previousTitle,
}: {
  current: VisualState | null;
  previous: VisualState | null;
  fade: number;
  currentTitle?: string | undefined;
  previousTitle?: string | undefined;
}) {
  return (
    <div class="lb-stage-layers">
      {previous && fade < 1 ? (
        <div class="lb-stage-layer" style={{ opacity: 1 - fade }}>
          <Visual state={previous} title={previousTitle} />
        </div>
      ) : null}
      {current ? (
        <div class="lb-stage-layer" style={{ opacity: previous ? fade : 1 }}>
          <Visual state={current} title={currentTitle} />
        </div>
      ) : null}
    </div>
  );
}
