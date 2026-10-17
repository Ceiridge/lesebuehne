/**
 * Table of sentence segmentation cases (German and English).
 * Each row: language, input paragraph, expected sentences (with their trailing whitespace),
 * so that `expected.join('')` is always the input.
 */
export interface SentenceRow {
  lang: string;
  note: string;
  text: string;
  expected: string[];
}

/** Probe text of research R3 (copied from probe-segmenter.ts, including its ASCII closing quote). */
export const R3_PROBE_TEXT =
  'Das ist z. B. ein Test. Dr. Müller kam am 3. Mai. Siehe S. 12 ff. Er sagte: „Habe Mut! Bediene dich." Dann ging er... Und das 3. Kapitel, d. h. der Rest, folgt u. a. später.';

const row = (lang: string, note: string, ...expected: string[]): SentenceRow => ({
  lang,
  note,
  text: expected.join(''),
  expected,
});

/** One row per quote style for each C14 rule. [open, close, style name] */
const QUOTE_STYLES: Array<[string, string, string]> = [
  ['„', '“', '„…“'],
  ['»', '«', '»…«'],
  ['"', '"', '"…"'],
  ['‚', '‘', '‚…‘'],
];

const quoteRows: SentenceRow[] = QUOTE_STYLES.flatMap(([o, c, style]) => [
  row('de', `closing quote stays with its sentence ${style}`, `Er sagte: ${o}Habe Mut!${c} `, 'Dann ging er.'),
  row('de', `quotation followed by a comma ${style}`, `${o}Komm her!${c}, rief er.`),
  row('de', `quotation followed by a lowercase continuation ${style}`, `${o}Komm her!${c} rief er.`),
  row('de', `two sentences inside one quotation ${style}`, `${o}Habe Mut! `, `Bediene dich.${c}`),
  row('de', `two sentences inside a quotation continued by a comma ${style}`, `${o}Habe Mut! `, `Bediene dich${c}, rief er.`),
  row('de', `two sentences inside a quotation continued in lowercase ${style}`, `${o}Habe Mut! `, `Bediene dich!${c} rief er.`),
  row('de', `dash dialogue ${style}`, `${o}Gehst du?${c} `, `– ${o}Ja.${c}`),
]);

export const SENTENCE_TABLE: SentenceRow[] = [
  // R3 probe (research/probe-segmenter.ts), whole text and its single cases
  row(
    'de',
    'R3 probe text',
    'Das ist z. B. ein Test. ',
    'Dr. Müller kam am 3. Mai. ',
    'Siehe S. 12 ff. ',
    'Er sagte: „Habe Mut! ',
    'Bediene dich." ',
    'Dann ging er... ',
    'Und das 3. Kapitel, d. h. der Rest, folgt u. a. später.',
  ),
  row('de', 'R3: z. B.', 'Das ist z. B. ein Test.'),
  row('de', 'R3: Dr. and ordinal before a month', 'Dr. Müller kam am 3. Mai.'),
  row('de', 'R3: S. 12 ff. ends a sentence', 'Siehe S. 12 ff. ', 'Er sagte es.'),
  row('de', 'R3: quotation with two sentences, ASCII close', 'Er sagte: „Habe Mut! ', 'Bediene dich." ', 'Dann ging er.'),
  row('de', 'R3: ellipsis before an uppercase start', 'Dann ging er... ', 'Und das war alles.'),
  row('de', 'R3: ordinal before a noun, d. h., u. a.', 'Und das 3. Kapitel, d. h. der Rest, folgt u. a. später.'),

  // Quotation rules (C14), one row per quote style
  ...quoteRows,
  row('de', 'closing quote stays with its sentence ›…‹', 'Er sagte: ›Habe Mut!‹ ', 'Dann ging er.'),
  row('de', 'closing quote stays with its sentence «…»', 'Er sagte: «Habe Mut!» ', 'Dann ging er.'),
  row('de', 'two sentences inside a quotation, then a new sentence', 'Er sagte: »Habe Mut! ', 'Bediene dich.« ', 'Dann ging er.'),
  row(
    'de',
    'three sentences inside a quotation continued by a comma',
    '„Ich weiß nicht. ',
    'Vielleicht morgen. ',
    'Vielleicht nie“, sagte sie.',
  ),
  row(
    'de',
    'four sentences inside a quotation continued by a comma',
    '„Ich komme morgen. ',
    'Wir gehen dann ins Kino. ',
    'Bring bitte Geld mit. ',
    'Und vergiss den Schirm nicht“, sagte er.',
  ),
  row('de', 'statement inside a quotation', '„Es regnet.“ ', 'Sie nickte.'),

  // Parentheses
  row('de', 'boundary after a closing parenthesis', '(Siehe S. 12.) ', 'Weiter.'),
  row('de', 'exclamation inside parentheses, lowercase continuation', 'Er kam (wie immer!) zu spät.'),
  row('de', 'two sentences inside parentheses continued in lowercase', 'Er kam (wie immer! Wirklich.) zu spät.'),
  row('de', 'two sentences inside parentheses, then a new sentence', '(Das ist gut. ', 'Das auch.) ', 'Weiter.'),
  row('de', 'abbreviations inside parentheses', 'Das ist wahr (vgl. Kap. 3). ', 'Weiter.'),

  // Apostrophe
  row('de', 'geht’s with a question mark', 'Wie geht’s dir? ', 'Gut, danke.'),
  row('de', 'geht’s inside a ‚…‘ quotation', 'Er fragte: ‚Wie geht’s?‘ ', 'Dann lachte er.'),
  row('de', 'geht’s is no closing quote of ‚', 'Er fragte: ‚Wie geht’s dir? ', 'Sag schon.‘, und sie schwieg.'),

  // Ellipsis
  row('de', 'three dots before lowercase', 'Er zögerte... dann ging er.'),
  row('de', 'ellipsis character before lowercase', 'Er zögerte … dann ging er.'),
  row('de', 'ellipsis character before an uppercase start', 'Er zögerte… ', 'Dann ging er.'),

  // Page numbers and ordinals
  row('de', 'S. 12 inside a sentence', 'Siehe S. 12 und S. 14.'),
  row('de', 'S. 12. at the end of a sentence', 'Das steht auf S. 12. ', 'Dann folgt mehr.'),
  row('de', 'ordinal before Auflage', 'Die 3. Auflage erschien 1784.'),
  row('de', 'ordinal before a month', 'Er kam am 3. Mai.'),
  row('de', 'ordinal before a month inside a sentence', 'Am 3. Mai 1784 kam er.'),
  row('de', 'ordinal before a lowercase word', 'Er kam als 3. ins Ziel.'),
  row('de', 'year at the end of a sentence', 'Er wurde 1784 geboren, im Jahr 1784. ', 'Dann zog er fort.'),
  row('de', 'ordinal and abbreviated month', 'Königsberg in Preußen, den 30. Septemb. 1784.'),

  // Kant, "Beantwortung der Frage: Was ist Aufklärung?" (1784)
  row('de', 'Kant: ! before a lowercase word', 'Habe Mut, dich deines eigenen Verstandes zu bedienen! ist also der Wahlspruch der Aufklärung.'),
  row(
    'de',
    'Kant: motto after "Sapere aude!" (uppercase start, boundary kept)',
    'Sapere aude! ',
    'Habe Mut, dich deines eigenen Verstandes zu bedienen! ist also der Wahlspruch der Aufklärung.',
  ),
  row('de', 'Kant: date line and signature', 'Königsberg in Preußen, den 30. Septemb. 1784. ', 'I. Kant.'),
  row('de', 'Kant: signature alone', 'I. Kant.'),

  // Further abbreviations and boundaries
  row('de', 'Prof. and a plain boundary', 'Prof. Kant las. ', 'Er schrieb viel.'),
  row('de', 'z. B. before an uppercase noun', 'Es gibt Obst, z. B. Äpfel und Birnen.'),
  row('de', 'z.B. without a space', 'Es gibt Obst, z.B. Äpfel.'),
  row('de', 'z. B. with a thin space', 'Es gibt Obst, z.\u2009B. Äpfel.'),
  row('de', 'z. B. with a narrow no-break space', 'Es gibt Obst, z.\u202FB. Äpfel.'),
  row('de', 'z. B. with a no-break space', 'Es gibt Obst, z.\u00A0B. Äpfel.'),
  row('de', 'd. h. and Dr.', 'Er kam, d. h. Dr. Meier kam.'),
  row('de', 'Vgl. at the start and Kap. before a number', 'Vgl. dazu Kap. 3.'),
  row('de', '? before a lowercase word', 'Was nun? fragte er.'),

  // Dash dialogue
  row('de', 'dash dialogue with an em dash', '„Gehst du?“ ', '— „Ja.“'),
  row('de', 'dash before a lowercase continuation', '„Gehst du?“ – fragte er.'),
  row('de', 'dash before an uppercase start without quotes', 'Er ging. ', '– Dann kam sie.'),

  // Abbreviations that are also words (F2), number words (R3), usw. (R2)
  row('de', 'Art. at the end of a sentence', 'Er tat es auf seine Art. ', 'Dann ging er.'),
  row('de', 'Art. before a number', 'Siehe Art. 5 des Gesetzes.'),
  row('de', 'Jan. as a name at the end of a sentence', 'Das sagte Jan. ', 'Dann ging er.'),
  row('de', 'Jan. before a year', 'Am 3. Jan. 1784 kam er.'),
  row('de', 'month abbreviation at the end of a sentence', 'Er kam am 3. Sept. ', 'Dann ging er.'),
  row('de', 'Mio. before a noun', 'Das kostet 5 Mio. Euro.'),
  row('de', 'Mrd. and Tsd. before nouns', 'Es gab 2 Mrd. Menschen und 3 Tsd. Tiere.'),
  row('de', 'Std. before a noun', 'Er lief 2 Std. Richtung Norden.'),
  row('de', 'Tel. before a number', 'Ruf an unter Tel. 030 1234.'),
  row('de', 'usw. at the end of a sentence', 'Er kaufte Äpfel, Birnen usw. ', 'Dann ging er.'),
  row('de', 'usw. before a lowercase word', 'Er kaufte Äpfel usw. und ging.'),

  // Known over-merges (accepted trade-offs, D24 and D25): documented as the current behaviour
  row('de', 'known over-merge: ordinal noun after a number at a sentence end', 'Er las Kapitel 3. Kapitel 4 war besser.'),
  row('de', 'known over-merge: a single capital at a sentence end', 'Er nahm Vitamin C. Danach schlief er.'),
  row('de', 'known over-merge: a name initial at a sentence end', 'Das war Maria K. Sie kam spät.'),
  row('de', 'three plain sentences', 'Es regnet. ', 'Die Sonne scheint! ', 'Ist das wahr?'),

  // English
  row('en', 'Mr. and a plain boundary', 'Mr. Smith arrived. ', 'He sat down.'),
  row('en', 'Dr.', 'Dr. Watson came in.'),
  row('en', 'e.g. before lowercase', 'Bring fruit, e.g. apples and pears.'),
  row('en', 'e.g. before uppercase', 'Bring fruit, e.g. Apples and pears.'),
  row('en', 'Mrs. and a plain boundary', 'Mrs. Hudson smiled. ', 'Then she left.'),
  row('en', 'the pronoun I is no initial', 'So did I. ', 'Then he left.'),
  row('en', 'initials', 'J. R. R. Tolkien wrote it.'),
  row('en', 'closing quote stays with its sentence “…”', 'He said, “Be brave!” ', 'Then he left.'),
  row('en', 'quotation followed by a lowercase continuation “…”', '“Come here!” he cried.'),
  row('en', 'two sentences inside a quotation continued by a comma “…”', '“Be brave! ', 'Help yourself,” he said.'),
];
