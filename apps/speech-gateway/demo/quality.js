// A reference-based edit rate, not a model confidence or clinical accuracy score.
export function compareTranscript(reference, hypothesis) {
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').trim();
  const characterMode = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(reference);
  const split = value => characterMode ? [...normalize(value).replace(/\s/gu, '')] : normalize(value).split(/\s+/u).filter(Boolean);
  const expected = split(reference), actual = split(hypothesis);
  if (!expected.length) return null;
  if (expected.length > 4000 || actual.length > 4000) return { limited: true };
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 1; i <= expected.length; i++) {
    const current = [i];
    for (let j = 1; j <= actual.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    previous = current;
  }
  return { metric: characterMode ? 'CER · character error rate' : 'WER · word error rate', errors: previous[actual.length], units: expected.length, rate: previous[actual.length] / expected.length };
}
