import type { SentenceRules } from './rules.ts';

export const RULES_EN: SentenceRules = {
  abbreviations: ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'St.', 'Jr.', 'Sr.', 'e.g.', 'i.e.', 'cf.', 'vs.', 'viz.'],
  numberAbbreviations: ['p.', 'pp.', 'No.', 'no.', 'Vol.', 'vol.', 'ch.', 'Ch.', 'Fig.', 'fig.'],
  ordinalWords: new Set(),
  initials: true,
  initialExceptions: ['I'],
};
