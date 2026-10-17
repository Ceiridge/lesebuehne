import { primaryLanguage, type Book, type Paragraph, type Section, type Sentence } from '@lesebuehne/core';

/** Function words that never make a key term. */
const STOPWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  de: new Set(
    `aber alle allem allen aller alles als also am an andere anderen anderer anders auch auf aus bei beim bin bis bisher bloß da dabei dadurch daher dafür dagegen damit dann daran darauf daraus darin darum darunter das dass daß dein deine dem den denen denn dennoch der deren derselben des desselben deshalb dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch eben ebenso ein eine einem einen einer eines einige einigen einiges einmal er es etwa etwas euch euer fast für gar gegen gewiss ganz gerade gewesen habe haben hat hatte hätte hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im immer in indem ins ist ja je jede jedem jeden jeder jedes jedoch jene jenem jenen jener jenes jetzt kann kein keine keinem keinen keiner können könnte machen man manche manchen mehr mein meine mich mir mit muss muß musste nach nachdem nein nicht nichts noch nun nur ob oder ohne schon sehr sei sein seine seinem seinen seiner seines seit selbst sich sie sind so solche solchen soll sollte sondern sonst soviel sowie über um und uns unser unsere unter viel vom von vor wann war waren warum was weder weil welche welchem welchen welcher welches wenig wenn wer werde werden wie wieder will wir wird wo wohl wollen worden wurde würde zu zum zur zwar zwischen teil teile weise fall falle grad grade art ansehung absicht sache dinge ding stück seite ende anfang zeit mal`.split(' '),
  ),
  en: new Set(
    `about above after again against all also although always among an and another any are as at be because been before being below between both but by can cannot could did do does doing down during each either else even ever every few for from further had has have having he her here hers herself him himself his how however if in into is it its itself just less like may might more most much must my myself neither never no nor not now of off often on once one only or other others our ours ourselves out over own rather same shall she should since so some such than that the their theirs them themselves then there these they this those though through thus to too under until upon very was we were what whatever when where whether which while who whom whose why will with within without would yet you your yours yourself also therefore thereupon whereas thing things everything nothing something anything contains contain means part parts way ways same certain great many well good another being made make makes know known called`.split(' '),
  ),
};

const MIN_LENGTH = 4;
const MAX_TERMS = 4;

interface Stat {
  /** Count per surface form. */
  forms: Map<string, number>;
  tf: number;
  /** Seen capitalised away from the sentence start (a noun or a named concept). */
  inner: boolean;
  emphasised: boolean;
  first: { sentence: Sentence; order: number };
}

const flow = (s: Section): Paragraph[] => s.paragraphs.filter((p) => p.kind !== 'heading' && p.kind !== 'figure' && p.kind !== 'footnote');

function sectionStats(section: Section, lang: string): Map<string, Stat> {
  const stop = STOPWORDS[lang] ?? new Set<string>();
  const stats = new Map<string, Stat>();
  let order = 0;
  for (const p of flow(section)) {
    const emphasised = (p.marks ?? []).filter((m) => m.kind === 'em' || m.kind === 'strong');
    for (const s of p.sentences) {
      let firstWord = true;
      for (const t of s.tokens) {
        order++;
        if (!t.wordLike || t.noteRef) continue;
        const atStart = firstWord;
        firstWord = false;
        const key = t.text.toLowerCase();
        if (key.length < MIN_LENGTH || stop.has(key) || !/^\p{L}[\p{L}-]*$/u.test(t.text)) continue;
        const capital = /^\p{Lu}/u.test(t.text);
        // German: only nouns (capitalised) are key-term candidates.
        if (lang === 'de' && !capital) continue;
        const stat = stats.get(key) ?? { forms: new Map(), tf: 0, inner: false, emphasised: false, first: { sentence: s, order } };
        stat.tf++;
        stat.forms.set(t.text, (stat.forms.get(t.text) ?? 0) + 1);
        if (capital && !atStart) stat.inner = true;
        if (emphasised.some((m) => m.start <= t.start && t.end <= m.end)) stat.emphasised = true;
        stats.set(key, stat);
      }
    }
  }
  return stats;
}

const dfCache = new WeakMap<Book, { n: number; df: Map<string, number> }>();

function documentFrequency(book: Book): { n: number; df: Map<string, number> } {
  const cached = dfCache.get(book);
  if (cached) return cached;
  const lang = primaryLanguage(book.language);
  const df = new Map<string, number>();
  let n = 0;
  for (const c of book.chapters) {
    for (const s of c.sections) {
      n++;
      for (const key of sectionStats(s, lang).keys()) df.set(key, (df.get(key) ?? 0) + 1);
    }
  }
  const result = { n, df };
  dfCache.set(book, result);
  return result;
}

export interface KeyTerm {
  /** Verbatim surface form, as it occurs in `sentence`. */
  term: string;
  sentence: Sentence;
  score: number;
}

/**
 * Key terms of a section (B9): content words that are frequent in this section and rare in the
 * rest of the book (TF-IDF), with a bonus for emphasis and for capitalised concepts. Function
 * words never qualify; a word must occur twice in the section unless it is emphasised.
 * Returned in reading order, at most four.
 */
export function keyTerms(section: Section, book: Book): KeyTerm[] {
  const lang = primaryLanguage(book.language);
  const { n, df } = documentFrequency(book);
  const scored: Array<KeyTerm & { order: number }> = [];
  for (const [key, stat] of sectionStats(section, lang)) {
    if (stat.tf < 2 && !stat.emphasised) continue;
    if (lang !== 'de' && !stat.inner && !stat.emphasised && stat.tf < 3) continue;
    const idf = Math.log((n + 1) / ((df.get(key) ?? 0) + 0.5));
    const score = stat.tf * Math.max(0.2, idf) * (stat.emphasised ? 2 : 1) * (stat.inner ? 1.4 : 1);
    const form = [...stat.forms].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key;
    // The anchor sentence must contain this exact form.
    const sentence = stat.first.sentence.tokens.some((t) => t.text === form)
      ? stat.first.sentence
      : (flow(section).flatMap((p) => p.sentences).find((s) => s.tokens.some((t) => t.text === form)) ?? stat.first.sentence);
    scored.push({ term: form, sentence, score, order: stat.first.order });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TERMS)
    .sort((a, b) => a.order - b.order)
    .map(({ term, sentence, score }) => ({ term, sentence, score }));
}
