CMU Pronouncing Dictionary
Source: https://github.com/cmusphinx/cmudict
Pinned commit: 74790861f652b15e4ac49015a90074ad62a27690

The application bundles a derived syllable index of every dictionary headword.
Numbered pronunciation variants are merged and ALL distinct syllable counts
are retained. Syllables are the count of ARPABET vowels with stress 0, 1, or 2.
Different counts remain unresolved; no first-pronunciation or spelling heuristic
is used. Entries with no stressed vowel (e.g. "shh") also require confirmation.
The application does not claim that dictionary syllables specify sung timing.

The original dictionary copyright and redistribution terms are in LICENSE.
provenance.json records the exact source hash, coverage, and measured index size.
Rebuild from the pinned upstream source: node scripts/build-dictionary.mjs
Optional offline inputs: node scripts/build-dictionary.mjs /path/cmudict.dict /path/LICENSE

The derived full index is compiled from src/analysis/cmudict-data.ts into the
application JavaScript so analysis needs no network request or external service.
