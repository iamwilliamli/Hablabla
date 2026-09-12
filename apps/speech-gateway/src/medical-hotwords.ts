import { readFileSync } from "node:fs";
import { parseNemotronHotwords } from "./protocol.js";

export const medicalSpecialties = [
  "cardiology", "respiratory", "endocrinology", "neurology",
  "gastroenterology", "renal", "musculoskeletal", "mental_health",
] as const;
export type MedicalSpecialty = typeof medicalSpecialties[number];
export type MedicalLanguage = "en" | "zh";
type Category = "general" | MedicalSpecialty;
type Catalog = {
  version: string;
  languages: Record<MedicalLanguage, Record<Category, string[]>>;
};
const catalog: Catalog = JSON.parse(readFileSync(
  new URL("../data/medical-hotwords.json", import.meta.url), "utf8",
));
export const medicalHotwordsVersion = catalog.version;

export interface MedicalHotwordOptions {
  language?: MedicalLanguage;
  specialties?: readonly MedicalSpecialty[];
  customTerms?: readonly string[];
  limit?: number;
}

/** Custom terms first, then specialties interleaved, then general vocabulary. */
export function getMedicalHotwords(options: MedicalHotwordOptions = {}): string[] {
  const { language = "en", specialties = [], customTerms = [], limit = 64 } = options;
  if (language !== "en" && language !== "zh") throw new Error("Unsupported medical hotword language");
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("limit must be an integer from 1 to 64");
  if (!Array.isArray(specialties) || specialties.some((s) => !medicalSpecialties.includes(s))) {
    throw new Error("Unsupported medical specialty");
  }
  // Validate before truncation so malformed custom input is never silently ignored.
  const custom = parseNemotronHotwords(customTerms);
  const words: string[] = [];
  const seen = new Set<string>();
  const add = (term: string) => {
    const normalized = term.normalize("NFC").trim();
    const key = normalized.toLowerCase();
    if (!seen.has(key)) { seen.add(key); words.push(normalized); }
  };
  custom.forEach(add);
  if (words.length > limit) throw new Error("Custom terms exceed the selected limit");
  const vocabulary = catalog.languages[language];
  const groups = [...new Set<MedicalSpecialty>(specialties)].map((s) => vocabulary[s]);
  for (let i = 0; i < Math.max(0, ...groups.map((g) => g.length)); i++) {
    for (const group of groups) if (i < group.length) add(group[i]);
  }
  vocabulary.general.forEach(add);
  return parseNemotronHotwords(words.slice(0, limit));
}
