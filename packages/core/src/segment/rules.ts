/**
 * Per-language correction tables for sentence segmentation. Languages without a table
 * use `Intl.Segmenter` without corrections.
 */
export interface SentenceRules {
  /**
   * Abbreviations after which a sentence never ends, written with their periods
   * (`'z. B.'`, `'Dr.'`). Multi-part abbreviations also match without the spaces
   * (`z.B.`) or with other spaces (`z.\u2009B.`). A variant with an uppercase first letter
   * is added automatically (`vgl.` → `Vgl.`).
   */
  abbreviations: readonly string[];
  /** Abbreviations after which a sentence does not end if a number follows (`S. 12`). */
  numberAbbreviations: readonly string[];
  /**
   * Words that continue a sentence after an ordinal number `\d+.` (`3. Mai`, `3. Auflage`).
   * Empty: no ordinal rule.
   */
  ordinalWords: ReadonlySet<string>;
  /** A single uppercase letter with a period is an initial (`I. Kant`). */
  initials: boolean;
  /** Uppercase letters that are never initials (English `I`). */
  initialExceptions: readonly string[];
}
