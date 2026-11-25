import type { ExamContentPackage } from '@/types/exam-admin';

/** Retain original JSON number tokens: canonical hashes distinguish integer and decimal metadata. */
export function parseContentBatch(text: string): Array<{ pkg: ExamContentPackage; json: string }> {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw new Error('Provide 1–50 content packages.');
  if (value.some((pkg) => !pkg || typeof pkg !== 'object' || Array.isArray(pkg)))
    throw new Error('Each content package must be an object.');
  const entries: string[] = [];
  let depth = 0, inString = false, escaped = false, start = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '[' || char === '{') {
      if (depth === 1) start = index;
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
      if (depth === 1 && start >= 0) { entries.push(text.slice(start, index + 1)); start = -1; }
    }
  }
  if (entries.length !== value.length) throw new Error('Invalid content batch boundaries.');
  return entries.map((json, index) => ({ pkg: value[index] as ExamContentPackage, json }));
}
