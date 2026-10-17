import type { SentenceRules } from './rules.ts';

const MONTHS = [
  'Januar', 'Jänner', 'Jan', 'Februar', 'Feb', 'Febr', 'März', 'Mrz', 'April', 'Apr', 'Mai', 'Juni', 'Jun',
  'Juli', 'Jul', 'August', 'Aug', 'September', 'Sep', 'Sept', 'Septemb', 'Oktober', 'Okt', 'Octob',
  'November', 'Nov', 'Novemb', 'Dezember', 'Dez', 'Dezemb', 'Decemb',
];

/** Nouns that often follow an ordinal number (`3. Auflage`, `18. Jahrhundert`). */
const ORDINAL_NOUNS = [
  'Auflage', 'Ausgabe', 'Band', 'Buch', 'Teil', 'Kapitel', 'Abschnitt', 'Absatz', 'Artikel', 'Paragraph',
  'Paragraf', 'Akt', 'Aufzug', 'Auftritt', 'Szene', 'Strophe', 'Vers', 'Brief', 'Lieferung', 'Folge',
  'Satz', 'Sinfonie', 'Symphonie', 'Jahrhundert', 'Jahrtausend', 'Jahrzehnt', 'Jahr', 'Monat', 'Woche',
  'Tag', 'Stunde', 'Mal', 'Stock', 'Stockwerk', 'Etage', 'Platz', 'Rang', 'Klasse', 'Reihe', 'Runde',
  'Hälfte', 'Geburtstag', 'Jahrestag', 'Todestag',
];

/**
 * Month abbreviations merge only before a digit (`Jan. 1784`): `Jan` is also a name, and a
 * date often ends a sentence (`am 3. Sept. Dann …`).
 */
const MONTH_ABBREVIATIONS = [
  'Jan.', 'Feb.', 'Febr.', 'Apr.', 'Aug.', 'Sep.', 'Sept.', 'Septemb.', 'Okt.', 'Octob.', 'Nov.',
  'Novemb.', 'Dez.', 'Dezemb.', 'Decemb.',
];

export const RULES_DE: SentenceRules = {
  // Not listed: `usw.`, `etc.`, `ff.`, `f.`, `Jh.`, `Jhd.`, `n. Chr.` often end a sentence.
  // Before a lowercase word or `, ; :` the sentences merge anyway.
  abbreviations: [
    'z. B.', 'd. h.', 'u. a.', 'u. ä.', 'o. ä.', 'u. U.', 'z. T.', 'i. d. R.', 'v. a.', 's. o.', 's. u.',
    'Dr.', 'Prof.', 'Hr.', 'Hrn.', 'Fr.', 'Frl.', 'St.', 'Nr.', 'Kap.', 'Abb.', 'Tab.', 'Bd.', 'Bde.',
    'Hg.', 'Hrsg.', 'Aufl.', 'Anm.', 'Abs.', 'vgl.', 'bzw.', 'ca.', 'ggf.', 'evtl.', 'inkl.',
    'insb.', 'bspw.', 'sog.', 'geb.', 'gest.', 'Mio.', 'Mrd.', 'Tsd.', 'Std.', 'Tel.',
  ],
  // `Art.` is also a noun (`auf seine Art.`): it merges only before a digit (`Art. 5`).
  numberAbbreviations: ['S.', 's.', 'Sp.', 'Bl.', 'Art.', ...MONTH_ABBREVIATIONS],
  ordinalWords: new Set([...MONTHS, ...ORDINAL_NOUNS]),
  initials: true,
  initialExceptions: [],
};
