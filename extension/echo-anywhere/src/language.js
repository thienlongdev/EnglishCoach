// Worker-only, offline. The bundled SCOWL US/GB spelling forms use the repository's locked
// 2026.02.25 dictionaries and Hunspell expansion. See language/SCOWL-LICENSE.txt.
const rejected = {
  error: {
    code: 'NOT_ENGLISH',
    message: 'Echo Anywhere chỉ hỗ trợ học tiếng Anh. Hãy chọn từ hoặc đoạn văn tiếng Anh nhé!',
  },
};
const uncertain = {
  error: {
    code: 'LANGUAGE_UNCERTAIN',
    message: 'Echo chưa chắc đây là tiếng Anh. Hãy chọn thêm vài từ trong cùng câu.',
  },
};
const accepted = { data: { english: true } };
const technical = new Set(
  'i a ai api apis gpu cpu css html http https sql javascript typescript json xml url urls ui ux github wifi javascript async await kubernetes blockchain oauth utf unicode unix linux ai-driven'.split(
    ' ',
  ),
);
const shared = new Set(
  'an am as die du qui chat pain son ton sale la le de en à dan can con cho ban toi'.split(' '),
);
const foreign = new Set(
  'tôi bạn các của những này người được đang tiếng không rất một học tôi mình đây là hãy với và muốn chúng xin chào cảm ơn bonjour merci salut voudrais apprendre français hola gracias buenos quiero aprender español hallo danke guten und ich uma você não obrigado grazie buongiorno ciao'.split(
    ' ',
  ),
);
const grammar = new Set(
  'the is are was were been this these those that they their them she her he his we our you your would could should will have has had it its from with into which what where when why how than who through there because although and for of in to my an if can do not'.split(
    ' ',
  ),
);
let dictionary;
function words() {
  if (!dictionary)
    dictionary = (async () => {
      const response = await fetch(chrome.runtime.getURL('language/english.txt.gz'));
      if (!response.ok) throw Error('Local dictionary unavailable');
      const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
      return new Set((await new Response(stream).text()).split('\n'));
    })().catch((error) => {
      dictionary = null;
      throw error;
    });
  return dictionary;
}

function codeOnly(text) {
  if (/\n/.test(text)) {
    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.filter(codeOnly).length > lines.length / 2;
  }
  if (/^[\w.]+(?:\s*(?:[+*/=%]|&&|\|\||=>|===|==)\s*[\w.]+)+;?$/.test(text) || /^[\W\d_]+$/u.test(text))
    return true;
  return (
    /^(?:const|let|var|def|function|class|import|export|return|if|for|while)\b[^.!?]*(?:[=;{}()]|:\s*$)/im.test(
      text,
    ) ||
    /^(?:select\b[\s\S]*\bfrom|(?:insert into|delete from|npm install|git (?:commit|push))\s)/i.test(text) ||
    /^(?:[.#]?[\w$.-]+\s*\([^)]*\)\s*;?|[\w$.[\]]+\s*(?:=>|===?|:=|\+=)\s*[^.!?]+;?|<\/?[\w:-]+(?:\s[^<>]*)?>.*|[.#\w-]+\s*\{[^}]*\})$/s.test(
      text,
    ) ||
    /^\s*(?:https?:\/\/|[\w.-]+@[\w.-]+\.)\S+\s*$/i.test(text)
  );
}

async function classify(raw) {
  const text = String(raw ?? '')
    .normalize('NFC')
    .replace(/[’‘]/g, "'")
    .trim();
  if (text.length > 60000) return uncertain;
  if (!text || codeOnly(text)) return rejected;
  const letters = text.match(/\p{L}/gu) || [];
  const latin = text.match(/\p{Script=Latin}/gu) || [];
  if (!latin.length || latin.length < letters.length * 0.65) return rejected;
  const tokens = text.toLowerCase().match(/\p{L}+(?:'\p{L}+)*/gu) || [];
  const dict = await words();
  let hits = 0,
    markers = 0,
    other = 0;
  for (const token of tokens) {
    if (
      dict.has(token) ||
      technical.has(token) ||
      grammar.has(token) ||
      /^(?:i|we|you|they|he|she|it|that|there)'(?:m|re|s|ll|ve|d)$/.test(token) ||
      (token.endsWith("'s") && dict.has(token.slice(0, -2)))
    )
      hits++;
    if (grammar.has(token)) markers++;
    if (foreign.has(token) || /[ăđơưạ-ỹ]/i.test(token)) other++;
  }
  if (other && (other >= tokens.length / 2 || (tokens.length <= 3 && !markers && hits < tokens.length / 2)))
    return rejected;
  if (tokens.length === 1 && shared.has(tokens[0])) return uncertain;
  if (tokens.length <= 3 && hits === tokens.length && !other) return accepted;
  if (tokens.length >= 3 && markers && hits >= tokens.length * 0.78 && !other) return accepted;
  const native = await chrome.i18n.detectLanguage(text).catch(() => null);
  const top = native?.languages?.[0];
  if (top && top.language !== 'und' && (native.isReliable || (tokens.length >= 3 && top.percentage >= 90))) {
    if (top.language !== 'en' && (hits < tokens.length * 0.8 || other)) return rejected;
    if (top.language === 'en' && hits >= tokens.length * 0.4 && (markers || hits >= 2)) return accepted;
  }
  if (hits === tokens.length && !other && tokens.length > 1) return accepted;
  if (tokens.length > 3 && markers >= 2 && hits >= tokens.length * 0.58 && other <= 1) return accepted;
  if (
    !hits &&
    (/([a-z])\1{3}/i.test(text) || /[bcdfghjklmnpqrstvwxz]{5,}/i.test(text) || /^[a-z]+[{};=]/i.test(text))
  )
    return rejected;
  return uncertain;
}

// Only the last validation, in volatile worker memory; no browsing history or persistent cache.
let lastText, lastResult;
export function validateSource(text) {
  if (typeof text !== 'string') return Promise.resolve(uncertain);
  if (text !== lastText) {
    lastText = text;
    lastResult = classify(text).catch(() => uncertain);
  }
  return lastResult;
}
