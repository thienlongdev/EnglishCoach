/**
 * "Vì sao hai ngôi sao này nối với nhau?" — a plain statement of exactly what the evidence says, never more: the relation,
 * its sense scope, its source and its limits. Deterministic text (no AI).
 */
import { METHOD_LABEL, RELATIONS } from './ontology';
import type { CosmosEdge, CosmosGraph } from './types';

export const POS_VI: Record<string, string> = { n: 'danh từ', v: 'động từ', a: 'tính từ', r: 'trạng từ' };
export const POS_EN: Record<string, string> = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };

/** The senses a graph refers to: [lemma, pos n|v|a|r, gloss, rank among the lemma's senses of that pos]. */
export type SenseTable = Record<number, [string, string, string, number]>;

export interface Explanation { title: string; lines: string[]; scopes: { a: string; b: string; posA: string; posB: string; glossA: string; glossB: string }[]; method: string; limits: string }

export function explainEdge(graph: CosmosGraph, senses: SenseTable | null, e: CosmosEdge, vi: boolean): Explanation {
  const s = graph.nodes[e.s], t = graph.nodes[e.t], r = RELATIONS[e.type];
  const name = vi ? r.vi : r.en;
  const method = (vi ? METHOD_LABEL[e.method].vi : METHOD_LABEL[e.method].en);
  const scopes: Explanation['scopes'] = [];
  if (senses) for (const [a, b] of e.scopes.slice(0, 4)) {
    const ia = a >= 0 ? senses[a] : undefined, ib = b >= 0 ? senses[b] : undefined;
    scopes.push({ a: s.label, b: t.label, posA: ia ? (vi ? POS_VI : POS_EN)[ia[1]] : '', posB: ib ? (vi ? POS_VI : POS_EN)[ib[1]] : '',
      glossA: ia?.[2] ?? '', glossB: ib?.[2] ?? '' });
  }
  const lines: string[] = [];
  if (e.status === 'SUGGESTED') {
    const via = graph.nodes[Number(e.note.slice(4))];
    lines.push(vi
      ? `Gợi ý khám phá, không phải một quan hệ đã kiểm chứng: "${s.label}" và "${t.label}" đều có quan hệ đã kiểm chứng với "${via?.label}".`
      : `An exploration hint, not a verified relation: "${s.label}" and "${t.label}" each have a verified relation with "${via?.label}".`);
    return { title: vi ? 'Gợi ý' : 'Suggestion', lines, scopes, method, limits: vi ? 'Hai từ này không được khẳng định là liên quan trực tiếp.' : 'The two words are not claimed to be directly related.' };
  }
  switch (e.type) {
    case 'SYNONYM_OF': lines.push(vi ? `"${s.label}" và "${t.label}" đồng nghĩa trong nghĩa dưới đây (không phải trong mọi nghĩa).` : `"${s.label}" and "${t.label}" are synonyms in the sense below (not in every sense).`); break;
    case 'ANTONYM_OF': lines.push(vi ? `"${s.label}" trái nghĩa với "${t.label}" trong nghĩa dưới đây.` : `"${s.label}" is the opposite of "${t.label}" in the sense below.`); break;
    case 'HYPERNYM_OF': lines.push(e.note === 'concept'
      ? (vi ? `"${t.label}" là một loại của khái niệm "${s.label}" (${e.steps} bậc trong WordNet). Khái niệm này là tâm của hệ sao, không phải từ bạn đã học.` : `"${t.label}" is a kind of "${s.label}" (${e.steps} level(s) in WordNet). The concept is the centre of this star system, not a word you studied.`)
      : (vi ? `"${t.label}" là một loại của "${s.label}" trong nghĩa dưới đây.` : `"${t.label}" is a kind of "${s.label}" in the sense below.`)); break;
    case 'PART_OF': lines.push(vi ? `"${s.label}" là một bộ phận của "${t.label}" trong nghĩa dưới đây.` : `"${s.label}" is a part of "${t.label}" in the sense below.`); break;
    case 'SIMILAR_TO': lines.push(e.note === 'concept'
      ? (vi ? `"${t.label}" thuộc cụm tính từ gần nghĩa quanh "${s.label}" trong WordNet. "${s.label}" là tâm của hệ sao, không phải từ bạn đã học.` : `"${t.label}" belongs to WordNet's adjective cluster around "${s.label}". It is the centre of this star system, not a word you studied.`)
      : vi ? `"${s.label}" và "${t.label}" gần nghĩa trong các nghĩa dưới đây (cùng một cụm tính từ), không phải đồng nghĩa hoàn toàn.` : `"${s.label}" and "${t.label}" are close in the senses below (one adjective cluster), not exact synonyms.`); break;
    case 'DERIVED_FORM': lines.push(vi ? `"${s.label}" và "${t.label}" cùng một gia đình từ (quan hệ phái sinh).` : `"${s.label}" and "${t.label}" belong to one word family (derivation).`); break;
    case 'IN_EXPRESSION': lines.push(vi ? `"${s.label}" là một chữ trong cụm cố định "${t.label}".` : `"${s.label}" is one of the words of the fixed expression "${t.label}".`); break;
    case 'PREREQUISITE_OF': lines.push(vi ? `Nên nắm "${s.sub || s.label}" trước khi học "${t.sub || t.label}".` : `"${s.label}" is a prerequisite of "${t.label}".`); break;
    case 'CONTRASTS_WITH': lines.push(vi ? `"${s.sub || s.label}" và "${t.sub || t.label}" được đặt cạnh nhau để đối chiếu${e.note === 'confusion' ? ' vì người học hay nhầm' : ''}.` : `"${s.label}" and "${t.label}" are set side by side for contrast${e.note === 'confusion' ? ' because learners often confuse them' : ''}.`); break;
    case 'ASSOCIATED_WITH': lines.push(vi ? `Grammar Academy liệt kê "${t.sub || t.label}" trong phần liên quan của "${s.sub || s.label}".` : `Grammar Academy lists "${t.label}" among the related topics of "${s.label}".`); break;
    case 'APPEARS_IN_SOURCE': lines.push(s.sub === 'MY_BOOKS'
      ? (vi ? `Dạng "${e.forms.join('", "')}" của "${t.label}" có trong đoạn bạn đã đánh dấu ở sách "${s.label}" (đọc trên thiết bị này).` : `The form(s) "${e.forms.join('", "')}" of "${t.label}" occur in a passage you highlighted in "${s.label}" (read on this device).`)
      : (vi ? `Dạng "${e.forms.join('", "')}" của "${t.label}" có trong "${s.label}".` : `The form(s) "${e.forms.join('", "')}" of "${t.label}" occur in "${s.label}".`)); break;
    case 'LEARNER_USED_IN': lines.push(vi ? `Bạn đã dùng dạng "${e.forms.join('", "')}" của "${t.label}" trong ${s.sub === 'WRITING' ? 'bài viết' : 'lời nói'} của mình.` : `You used the form(s) "${e.forms.join('", "')}" of "${t.label}" in your ${s.sub === 'WRITING' ? 'writing' : 'speaking'}.`); break;
    case 'CROSS_SKILL_TRANSFER': lines.push(vi ? `Bạn gặp ${e.words.length} từ trong "${s.label}" rồi sau đó dùng chúng trong ${t.sub === 'WRITING' ? 'bài viết' : 'lời nói'}: ${e.words.slice(0, 6).map(w => graph.nodes[w].label).join(', ')}.` : `You met ${e.words.length} word(s) in "${s.label}" and later used them in your ${t.sub === 'WRITING' ? 'writing' : 'speaking'}: ${e.words.slice(0, 6).map(w => graph.nodes[w].label).join(', ')}.`); break;
  }
  if (!e.posMatch && scopes.length) lines.push(vi ? 'Lưu ý: quan hệ này thuộc một từ loại khác với từ loại trên thẻ của bạn.' : 'Note: this relation belongs to a different part of speech than the one on your card.');
  lines.push(vi ? r.evidenceVi : r.evidenceEn);
  if (e.note === 'sole-sense') lines.push(vi
    ? 'WordNet chỉ có đúng một nghĩa cho từ này (nghĩa bên dưới), nên trong nguồn nó mang nghĩa đó — trong phạm vi các nghĩa WordNet ghi.'
    : 'WordNet has exactly one sense for this word (below), so in the source it has that sense — within the senses WordNet records.');
  const limits = e.category === 'source'
    ? (e.note === 'sole-sense'
      ? (vi ? 'Một cách dùng ngoài các nghĩa WordNet ghi sẽ không được nhận ra. Không phải đánh giá đúng sai.' : 'A use outside the senses WordNet records cannot be seen. Not a correctness judgement.')
      : (vi ? 'Không khẳng định nghĩa nào được dùng và không phải đánh giá đúng sai.' : 'It claims no sense and is not a correctness judgement.'))
    : e.category === 'expression' ? (vi ? 'Nghĩa của cụm không suy ra từ nghĩa của từng chữ.' : 'The phrase’s meaning is not derived from its words.')
    : e.category === 'grammar' ? (vi ? 'Liên kết do người biên soạn chọn, không phải đo từ kết quả của bạn.' : 'An authored link, not a measurement of your results.')
      : (vi ? 'Quan hệ chỉ đúng với nghĩa được nêu; các nghĩa khác của cùng chữ không được nối.' : 'True only for the stated sense; other senses of the same spelling are not linked.');
  return { title: name, lines, scopes, method, limits };
}
