/**
 * Utility helpers for Card Blast:
 * - Smart accent-tolerant string normalization
 * - Multi-synonym matching (commas, slashes, semicolons)
 * - Lexical hint masking for freeze action
 */

export function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’“”[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeVietnameseAccents(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Checks whether user input matches any target answer:
 * - Handles Vietnamese accents tolerance (e.g. "nghia vu" matches "nghĩa vụ")
 * - Handles case-insensitivity & whitespace normalization
 * - Handles comma-separated or slash-separated meanings
 * - Tolerates optional "to " prefix for English verbs
 */
export function checkWordMatch(input: string, targets: string[]): boolean {
  const normInput = normalizeText(input);
  if (!normInput) return false;
  const noAccentInput = removeVietnameseAccents(normInput);

  for (const target of targets) {
    if (!target) continue;
    // Split target on comma, slash, semicolon, or newline
    const splitOptions = target
      .split(/[,;\/\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const candidates = splitOptions.length > 0 ? splitOptions : [target];

    for (const cand of candidates) {
      const normCand = normalizeText(cand);
      if (!normCand) continue;
      const noAccentCand = removeVietnameseAccents(normCand);

      // 1. Direct or accent-free match
      if (normInput === normCand || noAccentInput === noAccentCand) {
        return true;
      }

      // 2. English "to " verb tolerance
      if (normCand.startsWith("to ")) {
        const withoutTo = normCand.slice(3).trim();
        if (normInput === withoutTo || noAccentInput === removeVietnameseAccents(withoutTo)) {
          return true;
        }
      }
      if (normInput.startsWith("to ")) {
        const inputWithoutTo = normInput.slice(3).trim();
        if (inputWithoutTo === normCand || removeVietnameseAccents(inputWithoutTo) === noAccentCand) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Generates partial masked letters for the hint system:
 * e.g. "sự phát triển lâu năm" -> "sự p___ t______ l__ n__"
 * e.g. "growing dependency" -> "g_____g d________y"
 */
export function getMaskedHint(targetText: string): string {
  if (!targetText) return "";
  // Use first meaning if comma-separated
  const primary = targetText.split(/[,;\/\n]+/)[0]?.trim() || targetText.trim();
  const words = primary.split(/\s+/);

  return words
    .map((w) => {
      const clean = w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’“”]/g, "");
      if (clean.length <= 2) return clean;

      const firstChar = clean[0];
      const hasTail = clean.length >= 6;
      const lastChar = hasTail ? clean[clean.length - 1] : "";
      const underscoresCount = Math.max(1, clean.length - 1 - (hasTail ? 1 : 0));
      const maskedMiddle = "_".repeat(underscoresCount);

      return `${firstChar}${maskedMiddle}${lastChar}`;
    })
    .join(" ");
}

/**
 * Gets clean list of candidate target strings from target array
 */
export function getCleanTargetCandidates(targets: string[]): string[] {
  const result: string[] = [];
  for (const t of targets) {
    if (!t) continue;
    const parts = t.split(/[,;\/\n]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      result.push(...parts);
    } else {
      result.push(t.trim());
    }
  }
  return result;
}

/**
 * Gets the cleanest primary answer string for letter box rendering
 */
export function getPrimaryTarget(targets: string[]): string {
  const candidates = getCleanTargetCandidates(targets);
  return candidates[0] || "";
}

/**
 * Checks if input is a prefix match for any target answer (accent-insensitive)
 */
export function checkPrefixMatch(input: string, targets: string[]): { isPrefixMatch: boolean; matchedTarget?: string } {
  const normInput = normalizeText(input);
  if (!normInput) return { isPrefixMatch: false };
  const noAccentInput = removeVietnameseAccents(normInput);

  const candidates = getCleanTargetCandidates(targets);
  for (const cand of candidates) {
    const normCand = normalizeText(cand);
    const noAccentCand = removeVietnameseAccents(normCand);

    if (normCand.startsWith(normInput) || noAccentCand.startsWith(noAccentInput)) {
      return { isPrefixMatch: true, matchedTarget: cand };
    }

    // Support optional "to " verb prefix in English
    if (normCand.startsWith("to ")) {
      const withoutTo = normCand.slice(3).trim();
      if (withoutTo.startsWith(normInput) || removeVietnameseAccents(withoutTo).startsWith(noAccentInput)) {
        return { isPrefixMatch: true, matchedTarget: cand };
      }
    }
  }

  return { isPrefixMatch: false };
}

export interface LetterBoxSlot {
  char: string;
  isSpace: boolean;
  isRevealed: boolean;
  isTyped: boolean;
  displayChar: string;
}

/**
 * Computes letter boxes for a target answer based on difficulty and current user input.
 * - Dễ (easy): 2 starting letters revealed
 * - Bình thường (normal): 1 starting letter revealed
 * - Siêu khó (hard): 0 starting letters revealed
 * - Typed letters fill the boxes in real-time as the user types
 */
export function getLetterBoxesData(
  target: string,
  input: string,
  difficulty: "easy" | "normal" | "hard",
  bonusRevealedIndices?: Set<number> | number[]
): { slots: LetterBoxSlot[]; isMatching: boolean } {
  if (!target) return { slots: [], isMatching: false };

  // If candidate starts with "to ", we focus on the base or the full string
  const primary = target.trim();
  const normInput = normalizeText(input);
  const noAccentInput = removeVietnameseAccents(normInput);

  const normTarget = normalizeText(primary);
  const noAccentTarget = removeVietnameseAccents(normTarget);

  const isMatching = normInput.length > 0 && (normTarget.startsWith(normInput) || noAccentTarget.startsWith(noAccentInput));

  // Determine starting letters to reveal: 2 for easy, 1 for normal, 0 for hard
  const revealCount = difficulty === "easy" ? 2 : difficulty === "normal" ? 1 : 0;

  const slots: LetterBoxSlot[] = [];
  let letterCounter = 0;
  let typedLetterCounter = 0;

  // Count non-space letters typed
  const typedLettersOnly = isMatching ? normInput.replace(/\s+/g, "") : "";

  for (let i = 0; i < primary.length; i++) {
    const rawChar = primary[i];
    if (/\s/.test(rawChar)) {
      slots.push({
        char: " ",
        isSpace: true,
        isRevealed: false,
        isTyped: false,
        displayChar: " ",
      });
      continue;
    }

    const isBonusRevealed = bonusRevealedIndices
      ? bonusRevealedIndices instanceof Set
        ? bonusRevealedIndices.has(letterCounter)
        : bonusRevealedIndices.includes(letterCounter)
      : false;

    const isRevealed = letterCounter < revealCount || isBonusRevealed;
    const isTyped = typedLetterCounter < typedLettersOnly.length;
    let displayChar = "";

    if (isTyped) {
      displayChar = rawChar; // or typed char
    } else if (isRevealed) {
      displayChar = rawChar;
    }

    slots.push({
      char: rawChar,
      isSpace: false,
      isRevealed,
      isTyped,
      displayChar,
    });

    letterCounter++;
    if (isMatching) {
      typedLetterCounter++;
    }
  }

  return { slots, isMatching };
}

/**
 * Truncates long definition prompts for falling cards:
 * - Strips excessive parenthetical notes (e.g. "(noun)", "(formal)", "[y học]", etc.)
 * - Truncates to first 45 characters with ellipsis (...) to prevent multi-line paragraph clutter.
 */
export function truncatePromptText(text: string, maxChars = 45): string {
  if (!text) return "";
  let clean = text
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s*\{[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // If stripping empty result (e.g. text was only "(test)"), fallback to original cleaned
  if (!clean && text.trim()) {
    clean = text.trim();
  }

  if (clean.length > maxChars) {
    return clean.slice(0, maxChars).trim() + "...";
  }
  return clean;
}

