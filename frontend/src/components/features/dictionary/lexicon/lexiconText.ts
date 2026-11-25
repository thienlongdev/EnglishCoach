/**
 * Echo Lexicon (owner brief 2026-10-24): text helpers shared by the global dictionary and the contextual popovers.
 * Presentation only — they never invent a meaning, a level or a frequency; they clean and label what the data says.
 */

/** Provider text cleaned for display: stray wiki markup / CSS, direction marks, spacing around punctuation. */
export function sanitizeLexicalText(text: string | undefined | null): string {
    if (!text) return "";
    let s = text;
    if (s.includes("mw-parser-output") || s.includes("{font-") || s.includes("<")) {
        s = s
            .replace(/<style[^>]*>.*?<\/style>/gis, "")
            .replace(/<script[^>]*>.*?<\/script>/gis, "")
            .replace(/\.?mw-parser-output[^{]*\{[^}]*\}/gi, "")
            .replace(/\.[a-zA-Z0-9_-]+\s*\{[^}]*\}/g, "")
            .replace(/<[^>]+>/g, "")
            .replace(/\.?mw-parser-output[\w-]*/gi, "");
    }
    return s
        .replace(/[‎‏‪-‮]/g, "")
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/([,;:])([^\s\d])/g, "$1 $2")
        .replace(/\s+\)/g, ")")
        .replace(/\(\s+/g, "(")
        .replace(/\s+/g, " ")
        .trim();
}

const POS_VI: Record<string, string> = {
    noun: "Danh từ",
    verb: "Động từ",
    adjective: "Tính từ",
    adj: "Tính từ",
    adverb: "Trạng từ",
    adv: "Trạng từ",
    pronoun: "Đại từ",
    preposition: "Giới từ",
    conjunction: "Liên từ",
    interjection: "Thán từ",
    determiner: "Hạn định từ",
    article: "Mạo từ",
    numeral: "Số từ",
    number: "Số từ",
    idiom: "Thành ngữ",
    phrase: "Cụm từ",
    "phrasal verb": "Cụm động từ",
    prefix: "Tiền tố",
    suffix: "Hậu tố",
    abbreviation: "Viết tắt",
    proverb: "Tục ngữ",
};

/** Vietnamese name of a part of speech as the data spells it; an unknown one is shown as it is. */
export function posLabelVi(pos: string | undefined | null): string {
    if (!pos) return "";
    const key = pos.trim().toLowerCase();
    return POS_VI[key] || POS_VI[key.replace(/_/g, " ")] || pos;
}

const ENTRY_TYPE_VI: Record<string, string> = {
    WORD: "Từ vựng",
    PHRASAL_VERB: "Cụm động từ",
    IDIOM: "Thành ngữ",
    COLLOCATION: "Cụm từ",
    EXPRESSION: "Cách diễn đạt",
};

export function entryTypeLabel(type: string | undefined | null): string {
    return (type && ENTRY_TYPE_VI[type]) || "Từ vựng";
}

/**
 * Wiktionary's note for a literal combination ("Used other than figuratively or idiomatically: see fall, back.") says
 * that the phrase means just its words. It is told as that, never shown as if it were a meaning.
 */
export function isLiteralNote(text: string | undefined | null): boolean {
    return !!text && /^used other than figuratively or idiomatically/i.test(text.trim());
}

/** Parts of a text with the headword (and its endings: fall → falls, fallen) marked, for emphasis in examples. */
export function markHeadword(text: string, headword: string | undefined | null): { t: string; hit: boolean }[] {
    const head = (headword || "").trim();
    if (!text || !head || head.length < 2) return [{ t: text, hit: false }];
    const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b(${escaped}[a-z]*)\\b`, "gi");
    const out: { t: string; hit: boolean }[] = [];
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
        out.push({ t: m[0], hit: true });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), hit: false });
    return out.length ? out : [{ t: text, hit: false }];
}

/**
 * How a collocation group is told. "Next word" groups (words attested right after the headword) are told by position
 * only; grammatical patterns keep their own names. `formula` draws the pattern with the headword in its place.
 */
export function collocationGroupLabel(pattern: string, headword: string): { title: string; formula: string[] } {
    const p = (pattern || "").trim().toLowerCase();
    switch (p) {
        case "next word":
            return { title: "Từ thường đi liền sau", formula: [headword, "…"] };
        case "adjective + noun":
            return { title: "Tính từ thường đi trước", formula: ["tính từ", headword] };
        case "verb + noun":
            return { title: "Động từ + danh từ", formula: ["động từ", "danh từ"] };
        case "verb + adjective":
            return { title: "Động từ + tính từ", formula: ["động từ", "tính từ"] };
        case "verb + adverb":
            return { title: "Động từ + trạng từ", formula: ["động từ", "trạng từ"] };
        case "noun + noun":
            return { title: "Danh từ + danh từ", formula: ["danh từ", "danh từ"] };
        case "adverb + adjective":
            return { title: "Trạng từ + tính từ", formula: ["trạng từ", "tính từ"] };
        default:
            return { title: pattern || "Cụm từ", formula: [] };
    }
}

export interface NestedSense<S> {
    sense: S;
    /** The sense's own gloss: a parent's text without the glosses of its sub-senses. */
    gloss: string;
    /** Examples not already shown under one of the group's other senses (a parent carries copies of its children's). */
    examples: string[];
    children: { sense: S; gloss: string; examples: string[] }[];
}

/**
 * Wiktionary sub-senses arrive twice: as a parent whose gloss is its own text followed by the glosses of the next
 * senses ("To be moved downwards. To move to a lower position under the effect of gravity.") and as those senses. They
 * are shown as one meaning with its sub-meanings: the parent keeps its own words, every sub-sense stays, and an example
 * is shown once, under the sense that has it on its own. Senses without that shape pass through unchanged.
 */
export function nestSenses<S extends { definitionEn?: string; examples?: string[] }>(senses: S[]): NestedSense<S>[] {
    const out: NestedSense<S>[] = [];
    const norm = (t?: string) => (t || "").replace(/\s+/g, " ").trim();
    let i = 0;
    while (i < senses.length) {
        const def = norm(senses[i].definitionEn);
        let take = 0;
        let parentGloss = def;
        if (def) {
            let suffix = "";
            for (let k = 1; i + k < senses.length && k <= 12; k++) {
                const child = norm(senses[i + k].definitionEn);
                if (!child) break;
                suffix = suffix ? `${suffix} ${child}` : child;
                if (def.length > suffix.length + 1 && def.endsWith(` ${suffix}`)) {
                    take = k;
                    parentGloss = def.slice(0, def.length - suffix.length).trim();
                } else if (!def.includes(child)) {
                    break;
                }
            }
        }
        const group = senses.slice(i + 1, i + 1 + take);
        const childExamples = new Set(group.flatMap((c) => (c.examples || []).map(norm)));
        out.push({
            sense: senses[i],
            gloss: take ? parentGloss : senses[i].definitionEn || "",
            examples: (senses[i].examples || []).filter((e) => !take || !childExamples.has(norm(e))),
            children: group.map((c) => ({ sense: c, gloss: c.definitionEn || "", examples: c.examples || [] })),
        });
        i += 1 + take;
    }
    // a parent's leftover copies of examples that a later sense owns (e.g. "The rain fell at dawn.") stay with that sense
    out.forEach((n, idx) => {
        if (!n.children.length) return;
        const later = new Set(out.slice(idx + 1).flatMap((m) => [...m.examples, ...m.children.flatMap((c) => c.examples)].map(norm)));
        n.examples = n.examples.filter((e) => !later.has(norm(e)));
    });
    return out;
}

/** A Vietnamese meaning compared without its final full stop and case (for de-duplication only). */
export function meaningKey(text: string): string {
    return text.replace(/[.。]\s*$/, "").trim().toLowerCase();
}
