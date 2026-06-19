# Vendored third-party data

## typos-words.csv

`typos-words.csv` is the typo-correction dictionary vendored verbatim from
**crate-ci/typos** (`crates/typos-dict/assets/words.csv`).

- Source: https://github.com/crate-ci/typos
- Format: `typo,correction[,correction2,...]` — one entry per line. Entries with
  more than one correction are *ambiguous* and are ignored by the loader
  (see `../typoDictionary.ts`); only unambiguous `typo,correction` pairs are
  used for deterministic single-word correction.
- License: dual-licensed under **MIT** OR **Apache-2.0** by the crate-ci/typos
  authors. This file is redistributed unmodified under those terms.

It is used only to normalise misspelled words in a user's prompt before the
phrase→filename matcher (`symbolPhraseMatch.ts`) resolves which file the prompt
is referring to. It never alters the user's prompt text itself.
