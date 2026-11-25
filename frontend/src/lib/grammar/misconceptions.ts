/**
 * Echo Grammar Academy: readable names for the misconception tags that exercise options carry (`"tag"` in the topic files).
 * A tag names the PATTERN behind a wrong answer ("thiếu mạo từ trước danh từ đếm được số ít"), not the learner. The map may be
 * sparse: new topics can bring new tags before this file knows them, so `labelOf` answers null for an unknown tag and each
 * screen falls back to the topic title instead of printing a raw id. Example-style tags (`written`, `spoken`, `informal`) are
 * register marks on examples, not misconceptions, and have no entry on purpose.
 */
type Pair = { vi: string; en: string };

const TAGS: Record<string, Pair> = {
  /* word order and the shape of a sentence */
  'adjective-after-noun': { vi: 'Đặt tính từ sau danh từ', en: 'Adjective placed after the noun' },
  'adverb-between-verb-object': { vi: 'Chen trạng từ giữa động từ và tân ngữ', en: 'Adverb squeezed between verb and object' },
  'adverb-very-before-verb': { vi: 'Dùng very ngay trước động từ', en: 'Using very right before a verb' },
  'order-meaning': { vi: 'Đọc nhầm vai trong câu vì thứ tự từ', en: 'Misreading who does what from word order' },
  'question-word-order': { vi: 'Sai thứ tự từ trong câu hỏi', en: 'Wrong word order in a question' },
  'double-object-order': { vi: 'Đặt sai thứ tự hai tân ngữ', en: 'Wrong order of two objects' },
  'double-object-overuse': { vi: 'Cho động từ hai tân ngữ khi nó không nhận', en: 'Giving a verb two objects when it cannot take them' },
  'obligatory-adverbial': { vi: 'Bỏ trạng ngữ bắt buộc', en: 'Leaving out a required adverbial' },
  'complement-vs-object': { vi: 'Nhầm bổ ngữ với tân ngữ', en: 'Mixing up complement and object' },

  /* what counts as a sentence, subject and predicate */
  'bare-ing-as-verb': { vi: 'Dùng dạng -ing một mình làm động từ chính', en: 'A bare -ing form used as the main verb' },
  'clause-count': { vi: 'Đếm sai số mệnh đề', en: 'Miscounting the clauses' },
  'dependent-as-sentence': { vi: 'Coi mệnh đề phụ thuộc là một câu trọn', en: 'Treating a dependent clause as a full sentence' },
  'main-vs-dependent': { vi: 'Nhầm mệnh đề chính với mệnh đề phụ', en: 'Mixing up main and dependent clauses' },
  'phrase-as-sentence': { vi: 'Coi một cụm từ là một câu', en: 'Treating a phrase as a sentence' },
  'subject-missing': { vi: 'Thiếu chủ ngữ', en: 'Missing subject' },
  'subject-equals-doer': { vi: 'Nhầm chủ ngữ với người làm hành động', en: 'Mixing up the subject and the doer' },
  'subject-head-only': { vi: 'Chỉ lấy danh từ chính làm chủ ngữ', en: 'Taking only the head noun as the subject' },
  'subject-predicate-swap': { vi: 'Nhầm chủ ngữ với vị ngữ', en: 'Mixing up subject and predicate' },
  'pronoun-wrong-referent': { vi: 'Chọn sai đại từ cho người hay vật', en: 'Wrong pronoun for the person or thing' },
  'agreement-distance': { vi: 'Chia động từ theo từ đứng gần, không theo chủ ngữ chính', en: 'Agreeing with the nearest word, not the real subject' },

  /* be, do, did and the auxiliaries */
  'am-is-are-agreement': { vi: 'Chọn sai am, is, are cho chủ ngữ', en: 'Wrong am, is or are for the subject' },
  'be-subject-agreement': { vi: 'Chọn sai is hoặc are theo chủ ngữ', en: 'Wrong is or are for the subject' },
  'was-were': { vi: 'Chọn sai was hoặc were', en: 'Wrong was or were' },
  'was-were-agreement': { vi: 'Chọn sai was hoặc were theo chủ ngữ', en: 'Wrong was or were for the subject' },
  'be-do-confusion': { vi: 'Nhầm be với do', en: 'Mixing up be and do' },
  'be-have-confusion': { vi: 'Dùng have thay cho be', en: 'Using have instead of be' },
  'be-plus-base': { vi: 'Thêm be trước động từ ở dạng gốc', en: 'Be followed by a base-form verb' },
  'be-plus-verb': { vi: 'Thêm be trước một động từ chính', en: 'Adding be before a main verb' },
  'copula-omission': { vi: 'Bỏ be trước tính từ', en: 'Leaving out be before an adjective' },
  'short-answer-contraction': { vi: 'Rút gọn be trong câu trả lời ngắn', en: 'Contracting be in a short answer' },
  'do-agreement': { vi: 'Chọn sai do hoặc does theo chủ ngữ', en: 'Wrong do or does for the subject' },
  'do-support-missing': { vi: 'Thiếu trợ động từ trong câu phủ định hoặc câu hỏi', en: 'Missing do-support in a negative or a question' },
  'do-support-verb-form': { vi: 'Động từ sau does không ở dạng gốc', en: 'Verb after does is not in the base form' },
  'aux-main-form': { vi: 'Chia -s hai lần, ở trợ động từ và ở động từ chính', en: 'Marking -s twice, on the auxiliary and the main verb' },
  'do-with-be': { vi: 'Dùng do với be', en: 'Using do with be' },
  'do-with-modal': { vi: 'Dùng do với động từ khuyết thiếu', en: 'Using do with a modal' },
  'did-be': { vi: 'Dùng did với be', en: 'Using did with be' },
  'did-past-form': { vi: 'Chia quá khứ cho động từ sau did', en: 'Past form on the verb after did' },
  'did-vs-do': { vi: 'Nhầm do với did', en: 'Mixing up do and did' },
  'modal-plus-s': { vi: 'Thêm -s sau động từ khuyết thiếu', en: 'Adding -s after a modal' },
  'not-before-main-verb': { vi: 'Đặt not ngay trước động từ chính', en: 'Putting not right before the main verb' },
  'third-person-s-missing': { vi: 'Thiếu -s ở ngôi thứ ba số ít', en: 'Missing -s in the third person singular' },

  /* tense and aspect */
  'tense-time-marker': { vi: 'Dùng thì không hợp với từ chỉ thời gian', en: 'A tense that clashes with the time word' },
  'tense-equals-time': { vi: 'Cho rằng dạng quá khứ luôn nói về quá khứ', en: 'Thinking a past form always means past time' },
  'tense-since-present': { vi: 'Dùng hiện tại tiếp diễn với since', en: 'Present continuous with since' },
  'future-is-a-verb-form': { vi: 'Cho rằng động từ có một dạng riêng cho tương lai', en: 'Thinking verbs have a dedicated future form' },
  'twelve-tenses-literal': { vi: 'Hiểu “mười hai thì” theo nghĩa đen', en: 'Taking “twelve tenses” literally' },
  'time-clause-will': { vi: 'Dùng will trong mệnh đề chỉ thời gian', en: 'Will inside a time clause' },
  'present-for-now': { vi: 'Dùng hiện tại đơn cho việc đang xảy ra', en: 'Present simple for something happening now' },
  'progressive-for-habit': { vi: 'Dùng tiếp diễn cho thói quen', en: 'Continuous for a habit' },
  'stative-progressive': { vi: 'Dùng tiếp diễn với động từ chỉ trạng thái', en: 'Continuous with a stative verb' },
  'meaning-shift-think': { vi: 'Dùng tiếp diễn với think khi nói ý kiến', en: 'Continuous with think for an opinion' },
  'continuous-no-be': { vi: 'Thiếu be trước dạng -ing', en: 'Missing be before an -ing verb' },
  'continuous-no-ing': { vi: 'Thiếu -ing sau be', en: 'Missing -ing after be' },
  'continuous-do-aux': { vi: 'Dùng did cùng với dạng -ing', en: 'Using did with an -ing form' },
  'continuous-for-event': { vi: 'Dùng tiếp diễn cho một sự kiện thoáng qua', en: 'Continuous for a single short event' },
  'continuous-for-news': { vi: 'Dùng tiếp diễn để báo tin', en: 'Continuous used to report news' },
  'aspect-open-vs-complete': { vi: 'Nhầm việc đang diễn ra với việc đã xong', en: 'Mixing up ongoing and completed' },
  'aspect-perfect-vs-continuous': { vi: 'Nhầm việc đã xong trước một mốc với việc đang diễn ra', en: 'Mixing up done-before and in-progress' },
  'past-bare-verb': { vi: 'Dùng dạng gốc cho việc đã qua', en: 'A base form for a past event' },
  'past-regularised': { vi: 'Thêm -ed vào động từ bất quy tắc', en: 'Adding -ed to an irregular verb' },
  'past-wrong-form': { vi: 'Chia sai dạng quá khứ', en: 'Wrong past form' },
  'past-simple-for-background': { vi: 'Dùng quá khứ đơn cho việc đang diễn ra làm nền', en: 'Past simple for a background action' },
  'past-perfect-no-reference': { vi: 'Dùng quá khứ hoàn thành khi chưa có mốc quá khứ', en: 'Past perfect with no past reference point' },
  'perfect-open-period': { vi: 'Dùng quá khứ đơn cho khoảng thời gian còn mở', en: 'Past simple for a period that is still open' },
  'been-gone': { vi: 'Nhầm been với gone', en: 'Mixing up been and gone' },

  /* imperatives */
  'imperative-agreement': { vi: 'Thêm -s vào câu mệnh lệnh', en: 'Adding -s to an imperative' },
  'imperative-doesnt': { vi: 'Dùng doesn’t trong câu mệnh lệnh', en: 'Using doesn’t in an imperative' },
  'imperative-not-dont': { vi: 'Dùng not thay cho don’t trong câu mệnh lệnh', en: 'Using not instead of don’t in an imperative' },
  'imperative-to-infinitive': { vi: 'Thêm to sau don’t', en: 'Adding to after don’t' },
  'imperative-too-direct': { vi: 'Mệnh lệnh quá thẳng với người lạ', en: 'An imperative too direct for a stranger' },

  /* articles and nouns */
  'article-omission': { vi: 'Thiếu mạo từ trước danh từ đếm được số ít', en: 'Missing article before a singular countable noun' },
  'article-a-an-sound': { vi: 'Chọn a hoặc an không theo âm đầu của từ', en: 'Choosing a or an without listening to the first sound' },
  'article-a-an-spelling': { vi: 'Chọn a hoặc an theo mặt chữ, không theo âm', en: 'Choosing a or an by spelling instead of sound' },
  'article-a-an-adjective': { vi: 'Quên đổi a hoặc an khi thêm tính từ', en: 'Forgetting to change a or an when an adjective is added' },
  'article-a-species': { vi: 'Dùng a hoặc an khi nói về cả loài', en: 'Using a or an for a whole species' },
  'article-uncountable-a': { vi: 'Dùng a hoặc an với danh từ không đếm được', en: 'Using a or an with an uncountable noun' },
  'uncountable-plural': { vi: 'Chia số nhiều cho danh từ không đếm được', en: 'Pluralising an uncountable noun' },
  'article-first-mention': { vi: 'Nhầm a và the khi nhắc đến lần đầu', en: 'Mixing up a and the on first mention' },
  'article-second-mention': { vi: 'Dùng a cho thứ đã được nhắc đến', en: 'Using a for something already mentioned' },
  'article-bridging': { vi: 'Dùng a cho thứ mà người nghe đã hiểu là cái nào', en: 'Using a for something the listener already knows' },
  'article-the-general': { vi: 'Dùng the khi nói chung chung', en: 'Using the when speaking generally' },
  'article-the-omission': { vi: 'Thiếu the trước dạng so sánh nhất', en: 'Missing the before a superlative' },
  'article-the-for-a': { vi: 'Dùng the thay cho a với nghĩa “mỗi”', en: 'Using the instead of a for “per”' },
  'article-plural-needs-article': { vi: 'Thêm mạo từ trước danh từ số nhiều nói chung', en: 'Adding an article before a general plural noun' },
  'article-determiner-stack': { vi: 'Đặt mạo từ ngay cạnh my, your, his', en: 'Placing an article next to my, your or his' },
  'possessive-of-me': { vi: 'Dùng me sau of thay cho mine', en: 'Me after of instead of mine' },
  'article-adj-group': { vi: 'Dùng tính từ trần để chỉ một nhóm người', en: 'A bare adjective used for a group of people' },
  'article-adj-plural': { vi: 'Thêm -s vào tính từ sau the', en: 'Adding -s to an adjective after the' },
  'generic-overclaim': { vi: 'Khẳng định quá mạnh khi nói chung', en: 'Overclaiming when generalising' },
  'article-institution-building': { vi: 'Dùng the cho nơi chốn khi muốn nói về hoạt động', en: 'Using the for a place when the activity is meant' },
  'article-institution-purpose': { vi: 'Bỏ mạo từ khi muốn nói đến tòa nhà', en: 'Dropping the article when the building is meant' },
  'article-institution-overuse': { vi: 'Bỏ the trước cinema và các nơi tương tự', en: 'Dropping the before cinema and similar places' },
  'article-transport-the': { vi: 'Thêm the sau by với phương tiện', en: 'Adding the after by with transport' },
  'article-home-to': { vi: 'Thêm to trước home', en: 'Adding to before home' },
  'article-name-a': { vi: 'Dùng a trước tên riêng', en: 'Using a before a proper name' },
  'article-name-the-extra': { vi: 'Thêm the trước tên thành phố', en: 'Adding the before a city name' },
  'article-name-the-omission': { vi: 'Thiếu the trước tên sông, biển, sa mạc', en: 'Missing the before river, sea and desert names' },
};

/** The readable name of a misconception tag, or null when this file does not know it yet (the caller falls back to the topic). */
export function labelOf(tag: string | null | undefined, vi = true): string | null {
  if (!tag) return null;
  const entry = TAGS[tag];
  return entry ? (vi ? entry.vi : entry.en) : null;
}

/** True when the tag has a readable name. */
export const isKnownTag = (tag: string | null | undefined): boolean => !!tag && tag in TAGS;
