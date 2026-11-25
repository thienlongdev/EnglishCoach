/**
 * Echo Neural Cosmos — the typed relation ontology (owner brief 2026-11-13).
 *
 * A relation type is ENABLED only when it has a validator below: a named source of evidence that states it. Types without one
 * are listed as disabled with the reason, and the engine never produces them. Different types need different evidence: a
 * co-occurrence in a text is never a synonym, a cause or a definition.
 */
export type RelationType =
  | 'SYNONYM_OF' | 'ANTONYM_OF' | 'HYPERNYM_OF' | 'PART_OF' | 'DERIVED_FORM' | 'SIMILAR_TO' | 'IN_EXPRESSION'
  | 'PREREQUISITE_OF' | 'CONTRASTS_WITH' | 'ASSOCIATED_WITH'
  | 'APPEARS_IN_SOURCE' | 'LEARNER_USED_IN' | 'CROSS_SKILL_TRANSFER';

/** Listed in the brief, deliberately NOT produced (no validator that meets their evidence standard exists offline). */
export const DISABLED_RELATIONS: Record<string, { vi: string; en: string }> = {
  COLLOCATION_WITH: { vi: 'Không vẽ thành cạnh: cần kho ngữ liệu có kiểm chứng tần suất. Hỏi vũ trụ chỉ nói hai từ đứng liền nhau trong câu nguồn của bạn (dùng có thật, không phải bằng chứng kết hợp từ cố định) và cụm nào WordNet ghi là một mục từ.', en: 'Never drawn: needs a frequency-checked corpus. Hỏi vũ trụ only reports two words standing next to each other in your sources (attested use, not proof of a collocation) and phrases WordNet lists as one entry.' },
  CAUSES: { vi: 'Không vẽ thành cạnh: vũ trụ không tự kiểm chứng nhân quả. Hỏi vũ trụ chỉ trích câu trong nguồn của bạn có từ nối nhân quả tường minh và nói rõ đó là lời của nguồn.', en: 'Never drawn: the universe does not verify causation. Hỏi vũ trụ only quotes sentences of your sources with an explicit causal connective, as the source’s claim.' },
  USED_IN_CONTEXT: { vi: 'Thay bằng "Xuất hiện trong nguồn" (dạng từ có trong văn bản). Nghĩa chỉ được nêu khi WordNet có đúng một nghĩa cho từ đó; từ nhiều nghĩa không bao giờ được gán nghĩa.', en: 'Replaced by "appears in source" (a word form occurs). A sense is stated only when WordNet has exactly one sense for the word; a word with several senses is never assigned one.' },
  EXAMPLE_OF: { vi: 'Ví dụ được xem trong Từ điển và thẻ, không vẽ thành cạnh.', en: 'Examples are shown in the dictionary and on cards, not drawn as edges.' },
  GRAMMAR_PATTERN: { vi: 'Chưa bật: chưa có bộ kiểm tra mẫu ngữ pháp theo từ.', en: 'Off: no word-level grammar pattern validator yet.' },
  LEARNER_MISTAKE_IN: { vi: 'Thay bằng lớp "Lỗ đen" từ các lần bạn tự chấm Khó (đánh giá của bạn, không phải lỗi dùng từ).', en: 'Replaced by the "black hole" layer from your own Hard ratings (self-rating, not a usage error).' },
  HYPONYM_OF: { vi: 'Là chiều ngược của "Khái niệm rộng hơn"; hiển thị bằng cùng một cạnh có hướng.', en: 'The inverse of "broader concept"; shown by the same directed edge.' },
  HAS_PART: { vi: 'Là chiều ngược của "Là một phần của"; hiển thị bằng cùng một cạnh có hướng.', en: 'The inverse of "part of"; shown by the same directed edge.' },
};

export type Method = 'OEWN_ENTRY' | 'OEWN_SYNSET' | 'OEWN_SENSE_RELATION' | 'OEWN_SYNSET_RELATION' | 'GRAMMAR_CATALOG' | 'FORM_MATCH' | 'EVIDENCE_ORDER' | 'PATH_SUGGESTION';
export type Status = 'VERIFIED' | 'SUGGESTED';
export type Category = 'lexical' | 'hierarchy' | 'part' | 'family' | 'expression' | 'grammar' | 'source' | 'transfer' | 'suggested';

export const RELATIONS: Record<RelationType, {
  vi: string; en: string; inverseVi?: string; inverseEn?: string; directed: boolean; category: Category; method: Method;
  evidenceVi: string; evidenceEn: string;
}> = {
  SYNONYM_OF: { vi: 'Đồng nghĩa', en: 'Synonym', directed: false, category: 'lexical', method: 'OEWN_SYNSET',
    evidenceVi: 'Open English WordNet xếp hai từ vào cùng một tập đồng nghĩa (synset), tức là cùng một nghĩa cụ thể.',
    evidenceEn: 'Open English WordNet places both words in one synset, i.e. one specific sense.' },
  ANTONYM_OF: { vi: 'Trái nghĩa', en: 'Antonym', directed: false, category: 'lexical', method: 'OEWN_SENSE_RELATION',
    evidenceVi: 'Open English WordNet ghi quan hệ trái nghĩa giữa hai nghĩa này.', evidenceEn: 'Open English WordNet records an antonym relation between these two senses.' },
  HYPERNYM_OF: { vi: 'Khái niệm rộng hơn', en: 'Broader concept', inverseVi: 'là một loại của', inverseEn: 'is a kind of', directed: true, category: 'hierarchy', method: 'OEWN_SYNSET_RELATION',
    evidenceVi: 'Open English WordNet ghi nghĩa này là một loại (hoặc một trường hợp) của nghĩa kia.', evidenceEn: 'Open English WordNet records one sense as a kind (or instance) of the other.' },
  PART_OF: { vi: 'Là một phần của', en: 'Part of', inverseVi: 'có bộ phận', inverseEn: 'has part', directed: true, category: 'part', method: 'OEWN_SYNSET_RELATION',
    evidenceVi: 'Open English WordNet ghi quan hệ bộ phận – toàn thể giữa hai nghĩa này.', evidenceEn: 'Open English WordNet records a part–whole relation between these senses.' },
  SIMILAR_TO: { vi: 'Gần nghĩa', en: 'Similar', directed: false, category: 'lexical', method: 'OEWN_SYNSET_RELATION',
    evidenceVi: 'Open English WordNet xếp hai nghĩa tính từ này vào cùng một cụm nghĩa gần (similar to): gần, nhưng không đồng nhất.',
    evidenceEn: 'Open English WordNet puts these adjective senses in one cluster (similar to): close, but not the same.' },
  DERIVED_FORM: { vi: 'Cùng gốc từ', en: 'Word family', directed: false, category: 'family', method: 'OEWN_SENSE_RELATION',
    evidenceVi: 'Open English WordNet ghi hai nghĩa này có quan hệ phái sinh (cùng gốc).', evidenceEn: 'Open English WordNet records a derivational relation between these senses.' },
  IN_EXPRESSION: { vi: 'Thành phần của cụm từ', en: 'Part of expression', inverseVi: 'gồm từ', inverseEn: 'contains', directed: true, category: 'expression', method: 'OEWN_ENTRY',
    evidenceVi: 'Open English WordNet ghi cụm này là MỘT mục từ (cụm cố định, ví dụ cụm động từ), và từ kia là một chữ của cụm. Nghĩa của cụm không suy ra từ nghĩa của từng chữ.',
    evidenceEn: 'Open English WordNet lists the phrase as ONE entry (a fixed expression such as a phrasal verb) and the other word is one of its words. The phrase’s meaning is not derived from its words.' },
  PREREQUISITE_OF: { vi: 'Cần học trước', en: 'Prerequisite', inverseVi: 'cần biết', inverseEn: 'builds on', directed: true, category: 'grammar', method: 'GRAMMAR_CATALOG',
    evidenceVi: 'Danh mục Echo Grammar Academy (biên soạn) ghi chủ điểm này là kiến thức nền của chủ điểm kia.', evidenceEn: 'The authored Echo Grammar Academy catalog lists this topic as a prerequisite of the other.' },
  CONTRASTS_WITH: { vi: 'Dễ nhầm / đối chiếu', en: 'Contrast', directed: false, category: 'grammar', method: 'GRAMMAR_CATALOG',
    evidenceVi: 'Danh mục Grammar Academy ghép hai chủ điểm để đối chiếu hoặc vì người học hay nhầm.', evidenceEn: 'The Grammar Academy catalog pairs these topics for contrast or as a common confusion.' },
  ASSOCIATED_WITH: { vi: 'Liên quan', en: 'Related', directed: false, category: 'grammar', method: 'GRAMMAR_CATALOG',
    evidenceVi: 'Danh mục Grammar Academy liệt kê chủ điểm này trong mục "liên quan" của chủ điểm kia.', evidenceEn: 'The Grammar Academy catalog lists this topic under the other one’s related topics.' },
  APPEARS_IN_SOURCE: { vi: 'Xuất hiện trong nguồn', en: 'Appears in source', directed: true, category: 'source', method: 'FORM_MATCH',
    evidenceVi: 'Một dạng của từ có trong văn bản bài bạn đã hoàn thành. Chỉ khẳng định dạng từ xuất hiện; không khẳng định nghĩa nào được dùng.',
    evidenceEn: 'A form of the word occurs in a text you completed. It claims only that the form occurs, not which sense is used.' },
  LEARNER_USED_IN: { vi: 'Bạn đã dùng', en: 'You used it', directed: true, category: 'source', method: 'FORM_MATCH',
    evidenceVi: 'Một dạng của từ có trong bài viết hoặc lời nói (bản ghi nhận dạng) của chính bạn. Không phải đánh giá đúng sai.',
    evidenceEn: 'A form of the word occurs in your own writing or recognised speech. It is not a correctness judgement.' },
  CROSS_SKILL_TRANSFER: { vi: 'Lỗ sâu kỹ năng', en: 'Skill wormhole', directed: true, category: 'transfer', method: 'EVIDENCE_ORDER',
    evidenceVi: 'Bạn gặp từ trong bài đọc hoặc bài nghe trước, rồi sau đó dùng nó khi viết hoặc nói (theo thời gian máy chủ ghi).',
    evidenceEn: 'You met the word in reading or listening first and later used it in writing or speaking (server-recorded times).' },
};

export const CATEGORY_COLOR: Record<Category, string> = {
  lexical: '#67e8f9', hierarchy: '#a5b4fc', part: '#5eead4', family: '#fde68a', expression: '#fda4af', grammar: '#f0abfc', source: '#86efac',
  transfer: '#fbbf24', suggested: '#e2e8f0',
};

export const CATEGORY_LABEL: Record<Category, { vi: string; en: string }> = {
  lexical: { vi: 'Đồng nghĩa, trái nghĩa', en: 'Synonyms, antonyms' },
  hierarchy: { vi: 'Rộng hơn / là một loại', en: 'Broader / kind of' },
  part: { vi: 'Bộ phận – toàn thể', en: 'Part – whole' },
  family: { vi: 'Cùng gốc từ', en: 'Word family' },
  expression: { vi: 'Cụm từ cố định (WordNet)', en: 'Fixed expressions (WordNet)' },
  grammar: { vi: 'Quan hệ ngữ pháp', en: 'Grammar links' },
  source: { vi: 'Nguồn và cách bạn dùng', en: 'Sources and your use' },
  transfer: { vi: 'Lỗ sâu kỹ năng', en: 'Skill wormholes' },
  suggested: { vi: 'Gợi ý (chưa kiểm chứng như một quan hệ)', en: 'Suggestions (not a verified relation)' },
};

export const METHOD_LABEL: Record<Method, { vi: string; en: string }> = {
  OEWN_ENTRY: { vi: 'WordNet: cụm là một mục từ', en: 'WordNet: the phrase is one entry' },
  OEWN_SYNSET: { vi: 'WordNet: cùng synset', en: 'WordNet: same synset' },
  OEWN_SENSE_RELATION: { vi: 'WordNet: quan hệ giữa hai nghĩa', en: 'WordNet: sense relation' },
  OEWN_SYNSET_RELATION: { vi: 'WordNet: quan hệ giữa hai synset', en: 'WordNet: synset relation' },
  GRAMMAR_CATALOG: { vi: 'Danh mục Grammar Academy (biên soạn)', en: 'Grammar Academy catalog (authored)' },
  FORM_MATCH: { vi: 'Đối chiếu dạng từ theo quy tắc (không dùng AI)', en: 'Rule-based word-form match (no AI)' },
  EVIDENCE_ORDER: { vi: 'Thứ tự thời gian của bằng chứng học', en: 'Time order of learning evidence' },
  PATH_SUGGESTION: { vi: 'Đường đi qua hai quan hệ đã kiểm chứng', en: 'Path through two verified relations' },
};
