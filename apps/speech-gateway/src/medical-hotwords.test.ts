import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMedicalHotwords, medicalSpecialties } from "./medical-hotwords.js";
import { parseNemotronHotwords } from "./protocol.js";

test("every catalog category satisfies the current gateway hotword contract", () => {
  const catalog = JSON.parse(readFileSync(new URL("../data/medical-hotwords.json", import.meta.url), "utf8"));
  for (const language of ["en", "zh"] as const) {
    for (const category of ["general", ...medicalSpecialties]) {
      const terms = catalog.languages[language][category] as string[];
      assert.ok(terms.length > 0);
      assert.deepEqual(parseNemotronHotwords(terms), terms);
      assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, terms.length);
    }
    for (const specialty of medicalSpecialties) {
      const terms = getMedicalHotwords({ language, specialties: [specialty] });
      assert.deepEqual(parseNemotronHotwords(terms), terms);
      assert.ok(terms.includes(catalog.languages[language][specialty][0]));
    }
  }
});

test("defaults are ready for English general medicine and results are independent", () => {
  const terms = getMedicalHotwords();
  assert.ok(terms.includes("metformin"));
  terms.length = 0;
  assert.ok(getMedicalHotwords().length > 0);
});

test("custom terms have priority, deduplicate by case, and survive specialty selection", () => {
  assert.deepEqual(getMedicalHotwords({
    specialties: ["cardiology"], customTerms: [" Apixaban ", "apixaban", "ECG"], limit: 4,
  }), ["Apixaban", "ECG", "atrial fibrillation", "atrial flutter"]);
});

test("multiple specialties interleave within the shared budget", () => {
  assert.deepEqual(getMedicalHotwords({
    language: "zh", specialties: ["cardiology", "renal", "cardiology"], limit: 4,
  }), ["心房颤动", "急性肾损伤", "心房扑动", "慢性肾脏病"]);
  assert.equal(getMedicalHotwords({ specialties: [...medicalSpecialties] }).length, 64);
});

test("invalid inputs fail instead of silently discarding custom vocabulary", () => {
  for (const limit of [0, 65, -1, 1.5, NaN]) assert.throws(() => getMedicalHotwords({ limit }));
  for (const customTerms of [[""], ["x".repeat(81)], Array(65).fill("term")]) {
    assert.throws(() => getMedicalHotwords({ customTerms }));
  }
  assert.throws(() => getMedicalHotwords({ customTerms: ["a", "b"], limit: 1 }));
  // @ts-expect-error Runtime callers may supply unsupported languages.
  assert.throws(() => getMedicalHotwords({ language: "fr" }));
  // @ts-expect-error Runtime callers may supply unsupported specialties.
  assert.throws(() => getMedicalHotwords({ specialties: ["unknown"] }));
});
