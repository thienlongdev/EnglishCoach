/** Last 12 explicit actions per account in this tab, for 24h. No response data, automatic requests or cross-account keys. */
export interface ProfessorAction { topic: string; question: string; sentence: string; id: string; at: number }
const TTL = 24 * 60 * 60 * 1000;
const key = (user: string) => `ec_grammar_professor:v1:${user}`;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

function actions(store: Store, user: string, now: number): ProfessorAction[] {
  try {
    const list: unknown = JSON.parse(store.getItem(key(user)) ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((a): a is ProfessorAction => a && typeof a.topic === 'string' && a.topic.length <= 80
      && typeof a.question === 'string' && a.question.length <= 500 && typeof a.sentence === 'string' && a.sentence.length <= 300
      && typeof a.id === 'string' && /^[0-9a-f-]{36}$/i.test(a.id) && Number.isFinite(a.at)
      && a.at <= now + 60_000 && now - a.at <= TTL).slice(0, 12);
  } catch { return []; }
}

export function restoreProfessorAction(store: Store, user: string, topic: string, now = Date.now()): ProfessorAction | null {
  return actions(store, user, now).find(a => a.topic === topic) ?? null;
}

export function professorAction(store: Store, user: string, topic: string, question: string, sentence: string,
                                forceNew = false, now = Date.now(), newId = () => crypto.randomUUID()): ProfessorAction {
  const previous = actions(store, user, now);
  const same = (a: ProfessorAction) => a.topic === topic && a.question === question && a.sentence === sentence;
  const found = forceNew ? undefined : previous.find(same);
  const action = { topic, question, sentence, id: found?.id ?? newId(), at: now };
  try { store.setItem(key(user), JSON.stringify([action, ...previous.filter(a => !same(a))].slice(0, 12))); }
  catch { /* The component ref still preserves same-mounted retries when browser storage is unavailable. */ }
  return action;
}
