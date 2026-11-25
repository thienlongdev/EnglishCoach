/**
 * Pure utility functions for text selection sanitization, lemmatization fallbacks,
 * and context sentence extraction in reading modals.
 */

/**
 * Sanitizes raw selected text.
 * - Trims and collapses internal whitespace.
 * - Strips leading and trailing punctuation and quotation marks.
 * - Rejects selections that are empty, contain no alphabetical letters,
 *   or exceed 4 words or 60 characters.
 */
export function sanitizeSelection(raw: string | null | undefined): string {
  if (!raw) return "";

  // 1. Collapse multiple whitespace characters into a single space and trim
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  // 2. Strip leading and trailing punctuation, quotes, brackets, and math symbols
  const sanitized = collapsed
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();

  if (!sanitized) return "";

  // 3. Must contain at least one alphabetical letter
  if (!/\p{L}/u.test(sanitized)) {
    return "";
  }

  // 4. Must not exceed 60 characters
  if (sanitized.length > 60) {
    return "";
  }

  // 5. Must not exceed 4 words
  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length > 4) {
    return "";
  }

  return sanitized;
}

/**
 * Builds up to 3 basic base-form (lemma) candidates for English word lookup retry.
 * Handles -s, -es, -ed, -ing, 's, and undoes consonant doubling.
 */
export function buildLemmaCandidates(rawWord: string): string[] {
  if (!rawWord) return [];
  const word = rawWord.trim().toLowerCase();
  if (word.length <= 2) return [];

  const candidates: string[] = [];

  // 1. Strip possessive 's or s'
  if (word.endsWith("'s") || word.endsWith("’s")) {
    candidates.push(word.slice(0, -2));
  } else if (word.endsWith("s'") || word.endsWith("s’")) {
    candidates.push(word.slice(0, -1));
  }

  // 2. Strip -ing
  if (word.endsWith("ing") && word.length > 4) {
    const base = word.slice(0, -3);
    // Undoing doubled consonant: e.g. "stopping" -> "stop", "running" -> "run"
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      candidates.push(base.slice(0, -1));
    }
    // Base with 'e': e.g. "making" -> "make", "hoping" -> "hope"
    candidates.push(base + "e");
    // Direct strip: e.g. "walking" -> "walk"
    candidates.push(base);
  }

  // 3. Strip -ed
  if (word.endsWith("ed") && word.length > 3) {
    const base = word.slice(0, -2);
    // Undoing doubled consonant: e.g. "planned" -> "plan", "stopped" -> "stop"
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      candidates.push(base.slice(0, -1));
    }
    // Ending with 'd' only: e.g. "liked" -> base is "lik", + 'e' -> "like"
    candidates.push(word.slice(0, -1));
    // Direct strip: e.g. "walked" -> "walk"
    candidates.push(base);
  }

  // 4. Strip -es / -s
  if (word.endsWith("ies") && word.length > 4) {
    // e.g. "cities" -> "city"
    candidates.push(word.slice(0, -3) + "y");
  } else if (word.endsWith("es") && word.length > 3) {
    // e.g. "watches" -> "watch", "boxes" -> "box"
    candidates.push(word.slice(0, -2));
    candidates.push(word.slice(0, -1)); // e.g. "tales" -> "tale"
  } else if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    // e.g. "books" -> "book"
    candidates.push(word.slice(0, -1));
  }

  // Deduplicate and filter out identical word or too short words
  const unique = Array.from(new Set(candidates)).filter(
    (c) => c !== word && c.length >= 2
  );

  return unique.slice(0, 3);
}

/**
 * Extracts the full sentence containing the selection within a parent container.
 * Clamped to 300 characters.
 */
export function extractContextSentence(
  range: Range | null | undefined,
  container: HTMLElement | null | undefined
): string {
  if (!range || !container) return "";

  try {
    // Determine containing block (paragraph or heading)
    let block: Node | null = range.commonAncestorContainer;
    while (block && block !== container && block.nodeType !== Node.ELEMENT_NODE) {
      block = block.parentNode;
    }
    if (!block || block === container) {
      block = range.startContainer.parentElement;
    }

    const fullText = (block?.textContent || container.textContent || "").replace(
      /\s+/g,
      " "
    );
    if (!fullText) return "";

    const selectedText = range.toString().trim();
    if (!selectedText) return fullText.slice(0, 300).trim();

    const selIndex = fullText.indexOf(selectedText);
    if (selIndex === -1) {
      return fullText.slice(0, 300).trim();
    }

    // Sentence punctuation lookbehind
    const textBefore = fullText.slice(0, selIndex);
    const startPunct = Math.max(
      textBefore.lastIndexOf(". "),
      textBefore.lastIndexOf("! "),
      textBefore.lastIndexOf("? "),
      textBefore.lastIndexOf(".\n")
    );
    const sentenceStart = startPunct !== -1 ? startPunct + 2 : 0;

    // Sentence punctuation lookahead
    const textAfter = fullText.slice(selIndex + selectedText.length);
    const endMatch = textAfter.match(/[.!?](\s|$)/);
    const sentenceEnd = endMatch && endMatch.index !== undefined
      ? selIndex + selectedText.length + endMatch.index + 1
      : fullText.length;

    const sentence = fullText.slice(sentenceStart, sentenceEnd).trim();
    return sentence.length > 300 ? sentence.slice(0, 300).trim() + "..." : sentence;
  } catch {
    return "";
  }
}
