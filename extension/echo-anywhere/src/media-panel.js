import { send, h, dictionaryView, aiView, quizView, errorView, speak } from './ui.js';
import { allowShare } from './consent-ui.js';
import { parseCues, cueIndex, normalizeAnswer, exercise } from './media-model.js';

import { synchronizeCues } from './vendor/duetsub/synchronizer.js';
import { deviceTranslator } from './media-device.js';

const button = (label, fn, primary = false) =>
  h('button', { type: 'button', class: 'btn' + (primary ? ' primary' : ''), onclick: fn }, label);
const row = (...nodes) => h('div', { class: 'row' }, ...nodes);
const select = (label, options) =>
  h(
    'select',
    { 'aria-label': label },
    ...options.map(([v, title]) => h('option', { value: v, text: title })),
  );
const timeLabel = (s) =>
  Number.isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '';
const questions = {
  natural: 'Giải nghĩa tự nhiên bằng tiếng Việt trong ngữ cảnh của riêng câu trích dẫn.',
  metaphor:
    'Phân biệt nghĩa trực tiếp và cách hiểu ẩn dụ, tiếng lóng hay cảm xúc. Đánh dấu suy diễn và không khẳng định dụng ý của tác giả.',
  grammar: 'Phân tích cấu trúc ngữ pháp, thành ngữ, cụm động từ hoặc dạng rút gọn thực sự xuất hiện.',
  sound:
    'Giải thích các khả năng nối âm, lược âm và trọng âm trong câu. Không suy đoán cách ca sĩ cụ thể đã hát.',
};
export function mountMedia(panel, tabId, getAccount) {
  let port = null,
    disposed = false,
    generation = 0,
    revision = 0,
    scope = null,
    attached = false,
    custom = false;
  let cues = [],
    vietnamese = [],
    index = -1,
    activeTime = 0,
    word = '',
    manual = false,
    exerciseActive = false;
  let pointA = null, reconnectTimer, nativeCursor, nativeLine='',sourceEpoch=0, batchEpoch=0, observed=false;
  const device=deviceTranslator(),chapterBox=h('div',{class:'stack'}),question=h('input',{maxlength:300,'aria-label':'Câu hỏi về đoạn phụ đề',placeholder:'Hỏi về nội dung đoạn đang chọn'});
  const overlay=h('input',{type:'checkbox'}), view=select('Kiểu hiển thị',[['scroll','Cuộn theo câu'],['line','Một câu'],['transcript','Danh sách phụ đề']]);
  const readTranscript=button('Đọc bản chép lời đang mở',()=>post({type:'transcript'}));
  let chapterData=[], aiChapters=new Map(),lastOverlay='';
  const redrawOverlay=()=>{const msg={type:'overlay',text:overlay.checked && !exerciseActive && !document.hidden ? line()?.text || '' : '',vi:bilingual.checked?translation.textContent:'',size:size.value};const key=JSON.stringify(msg);if(key!==lastOverlay){lastOverlay=key;post(msg);}};
  const trObserver=new MutationObserver(redrawOverlay);
  const resetDevice=()=>{sourceEpoch++;batchEpoch++;remoteBudget=0;device.clear();nativeCursor=undefined;nativeLine='';};
  
  let remoteBudget=0, translating = false,
    queued = false,
    recorder,
    recordStream,
    audioUrl,
    recordTimer,
    recognizer;
  const aiPending = new Set(),
    aiResults = new Map(),
    localTranslations = new Map();
  const status = h('p', { class: 'muted small', role: 'status' });
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  const caption = h('p', { class: 'media-line' }),
    translation = h('p', { class: 'general' }),
    ipa = h('p', { class: 'muted' });
  const transcript = h('div', { class: 'transcript', 'aria-label': 'Danh sách câu' });
  const words = h('input', {
    type: 'text',
    'aria-label': 'Từ hoặc cụm từ',
    placeholder: 'Chọn từ hoặc nhập cụm từ trong câu',
    maxlength: 150,
  });
  const source = h('textarea', {
    'aria-label': 'Phụ đề hoặc trích đoạn',
    placeholder: 'Dán SRT, VTT hoặc một trích đoạn tiếng Anh bạn có quyền dùng',
    maxlength: 60000,
  });
  const file = h('input', {
    type: 'file',
    accept: '.srt,.vtt,text/vtt,text/plain',
    'aria-label': 'Tệp phụ đề của bạn',
  });
  const importLang = select('Ngôn ngữ tệp', [
    ['en', 'Tiếng Anh'],
    ['vi', 'Tiếng Việt · ghép phụ đề'],
  ]);
  const bilingual = h('input', { type: 'checkbox' }),
    autoPause = h('input', { type: 'checkbox' }),
    follow = h('input', { type: 'checkbox', checked: true });
  const mode = select('Không gian học', [
    ['video', 'Echo Video Companion'],
    ['lyrics', 'Echo Lyrics Lab'],
    ['karaoke', 'Echo Karaoke Learning'],
  ]);
  const speed = select('Tốc độ phát', [
    [1, '1×'],
    [0.5, '0.5×'],
    [0.75, '0.75×'],
    [1.25, '1.25×'],
    [1.5, '1.5×'],
  ]);
  const card = h('div', { class: 'card stack' });
  const mt = button('Dịch câu đang chọn', () => translateLine(true));
  const tools = h('div', { class: 'stack' }),
    drill = h('div', { class: 'card stack' });
  const transcriptPage = h('div', { class: 'stack' });
  const recordStatus = h('span', { role: 'status', class: 'recording' }),
    recordOut = h('div', { class: 'stack' });
  let recordingRequest = 0;
  const line = () => cues[index];
  const notify = (text) => {
    if (!disposed) status.textContent = text;
  };
  const post = (message) => {
    try {
      port?.postMessage(message);
    } catch {
      notify('Trình phát đã ngắt kết nối.');
    }
  };
  async function accepted(text) {
    const r = await send({ t: 'language:check', text });
    if (!r?.data?.english) {
      notify(r?.error?.message || 'Hãy chọn đoạn tiếng Anh.');
      return false;
    }
    return !disposed;
  }
  function stopMic() {
    recordingRequest++;
    clearTimeout(recordTimer);
    if (recorder?.state === 'recording') recorder.stop();
    recordStream?.getTracks().forEach((t) => t.stop());
    recordStream = null;
    recognizer?.stop();
    recognizer = null;
    recordStatus.textContent = '';
  }
  function clearSource() {
    resetDevice(); observed=false;chapterData=[];aiChapters.clear();chapterBox.replaceChildren();question.value='';readTranscript.hidden=true;
    post({type:'overlay',text:''});lastOverlay='';revision++;
    cues = [];
    vietnamese = [];
    index = -1;
    pointA = null;
    word = '';
    manual = false;
    custom = false;
    exerciseActive = false;
    localTranslations.clear();
    aiResults.clear();
    caption.hidden = false;
    transcriptPage.hidden = false;
    caption.replaceChildren();
    translation.replaceChildren();
    ipa.replaceChildren();
    out.replaceChildren();
    drill.replaceChildren();
    recordOut.replaceChildren();
    transcript.replaceChildren();
    words.value = '';
    stopMic();
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
    send({ t: 'media:cancel' });
    post({ type: 'clear' });
  }
  async function attach() {
    clearTimeout(reconnectTimer);
    const serial = ++generation;
    port?.disconnect();
    port = null;
    clearSource();
    attached = false;
    scope = null;
    notify('Đang tìm trình phát được phép truy cập…');
    const r = await send({ t: 'media:attach', tabId });
    if (disposed || serial !== generation) return;
    if (!r?.data) {
      notify(r?.error?.message || 'Hãy tự dán phụ đề hoặc lời nhạc.');
      return;
    }
    const connection = chrome.tabs.connect(r.data.tabId, {
      documentId: r.data.documentId,
      name: 'echo-media',
    });
    port = connection;
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== connection || disposed) return;
      attached = false;
      port = null;
      clearSource();
      notify('Trình phát đã đổi. Kết nối lại hoặc dùng văn bản của bạn.');
    });
    connection.onMessage.addListener((m) => {
      if (disposed || connection !== port) return;
      if(m.type==='switch'){
        port=null;attached=false;scope=null;clearSource();notify('Trình phát đã đổi.');
        if(m.reconnect)reconnectTimer=setTimeout(()=>{if(!disposed)attach();},750);
        return;
      }
      if(m.type==='pick' && m.text===line()?.text){manual=true;words.value=m.word;lookup();return;}
      if(m.type==='transcript'){
        if(!m.lines?.length){notify('Mở “Show transcript / Hiện bản chép lời” của chính video, rồi thử lại. Bạn cũng có thể nhập SRT/VTT.');return;}
        clearSource();custom=true;cues=m.lines;chapterData=m.chapters||[];drawChapters();readTranscript.hidden=false;
        display(Math.max(0,cueIndex(cues,activeTime)));notify('Bản chép lời đang mở · '+cues.length+' câu có mốc thời gian.');return;
      }
      if(m.type==='visible' && !custom){
        const lang=(m.lang||'').toLowerCase();if(lang && !/^en(?:-|$)/.test(lang)){if(!m.closed)notify('Chọn phụ đề English trong trình phát để học.');return;}
        if(!observed && cues.length)return;
        observed=true;
        const existing=cues.find(c=>c.start===m.start && c.text===m.text);
        if(existing){existing.end=m.end;return;}
        const current=line();cues.push({start:m.start,end:m.end,text:m.text});cues.sort((a,b)=>a.start-b.start);
        if(cues.length>120)cues.splice(cues.findIndex(c=>c!==current && c.start!==m.start),1);
        index=cues.indexOf(current);if(cues.length%8===1)drawChapters();
        if(!m.closed && !exerciseActive && !manual && follow.checked)display(cues.findIndex(c=>c.start===m.start && c.text===m.text));
        notify('CC hiển thị trên YouTube · thời gian quan sát gần đúng.');return;
      }
      if (m.type === 'attached') {
        attached = true;
        scope = m.scope;
        return;
      }
      if (m.type === 'manual') {
        scope = m.scope;
        attached = false;
        notify(m.message);
        return;
      }
      if (m.type === 'error') {
        notify(m.message);
        return;
      }
      if (m.type === 'reset') {
        clearSource();
        return;
      }
      if (m.type === 'tracks' && !custom) {
        readTranscript.hidden=!m.youtube;chapterData=m.chapters||[];drawChapters();
        if(observed && !m.en.length)return;
        observed=false;nativeCursor=undefined;nativeLine='';cues = m.en;
        vietnamese = m.vi;drawChapters();
        index = -1;
        notify(
          cues.length
            ? 'Đã đọc phụ đề của trình phát trên thiết bị.'
            : m.youtube?'Bật CC tiếng Anh trong YouTube, hoặc mở bản chép lời rồi bấm đọc.': 'Trình phát chưa cung cấp phụ đề tiếng Anh. Hãy dùng SRT/VTT hoặc dán trích đoạn.',
        );
        if (cues.length) display(Math.max(0, cueIndex(cues, activeTime)));
        else renderTranscript();
      }
      if (m.type === 'time') {
        activeTime = m.time;
        if(!manual && bilingual.checked && vietnamese.length && !exerciseActive){
          const synced=synchronizeCues([],vietnamese,activeTime,nativeCursor);nativeCursor=synced.state;
          const v=synced.bottomActive.map(c=>c.text).join(' ');
          if(v!==nativeLine){nativeLine=v;translation.textContent=v;}
        }
        if (!manual && !exerciseActive && follow.checked) {
          const i = cueIndex(cues, m.time);
          if (i >= 0 && i !== index) display(i);
          else if (i < 0 && index >= 0 && !m.paused) {
            revision++;
            index = -1;
            redrawOverlay();caption.replaceChildren();
            translation.textContent = '';
            ipa.textContent = '';
            words.value = '';
            out.replaceChildren();
            renderTranscript();
          }
        }
      }
      if (
        m.type === 'cue' &&
        !custom &&
        m.lang === 'en' &&
        !cues.some((c) => c.start === m.start && c.text === m.text)
      ) {
        cues.push({ start: m.start, end: m.end, text: m.text });
        cues.sort((a, b) => a.start - b.start);
        if (cues.length > 2500) cues.shift();
        if (!exerciseActive && follow.checked) display(cueIndex(cues, m.start));
      }
      if (
        m.type === 'cue' &&
        !custom &&
        m.lang === 'vi' &&
        bilingual.checked &&
        !manual &&
        line() &&
        m.end > line().start &&
        m.start < line().end
      )
        translateLine(false);
      if (m.type === 'asr') {
        custom = true;
        cues.push({ start: m.start, end: m.end, text: m.text });
        display(cues.length - 1);
      }
      if (m.type === 'asr-start') notify('Đang nhận dạng âm thanh trên thiết bị · tối đa 30 giây.');
      if (m.type === 'asr-end') notify('Đã dừng nhận dạng âm thanh.');
    });
    connection.postMessage({ type: 'attach' });
  }
  function renderTranscript(offset = Math.max(0, index - 5)) {
    const start = Math.max(0, Math.min(offset, Math.max(0, cues.length - 15)));
    const items = cues.slice(start, start + 15).map((c, n) =>
      h(
        'button',
        {
          type: 'button',
          'aria-current': String(start + n === index),
          onclick: () => {
            exerciseActive = false;
            manual = true;
            display(start + n);
            if(attached && Number.isFinite(c.start)){activeTime=c.start;post({type:'seek',start:c.start});}
          },
        },
        (timeLabel(c.start) + ' ' + c.text).trim(),
      ),
    );
    transcriptPage.hidden=exerciseActive||view.value==='line';
    transcript.replaceChildren(...items);
    transcriptPage.replaceChildren(transcript);
    if (cues.length > 15)
      transcriptPage.append(
        row(
          button('Trước', () => renderTranscript(start - 15)),
          button('Sau', () => renderTranscript(start + 15)),
        ),
      );
  }
  function display(i) {
    if (!cues[i]) return;
    revision++;
    index = i;
    word = '';
    words.value = '';
    ipa.textContent = '';
    out.replaceChildren();
    translation.textContent = '';
    const c = cues[i];
    caption.replaceChildren();
    for (const token of c.text.split(/(\p{L}+(?:['’–-]\p{L}+)*)/gu)) {
      if (!token) continue;
      caption.append(
        /^\p{L}/u.test(token)
          ? h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  manual = true;
                  words.value = token;
                  lookup();
                },
              },
              token,
            )
          : document.createTextNode(token),
      );
    }
    redrawOverlay();renderTranscript();
    if (bilingual.checked) translateLine(false);
    if (autoPause.checked && !manual) control(false, false);
  }
  async function translateLine(explicit) {
    const c = line();
    if (!c || disposed || exerciseActive) return;
    const ref = revision;
    const at=!manual && activeTime>=c.start && activeTime<c.end?activeTime:c.start;
    const nativeText=Number.isFinite(at) ? synchronizeCues([],vietnamese,at).bottomActive.map(x=>x.text).join(' ') : '';
    const vi=nativeText?{text:nativeText}:null;
    if (vi) {
      if ((await accepted(c.text)) && revision === ref) translation.textContent = vi.text;
      return;
    }
    const key = c.text.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (localTranslations.has(key)) {
      translation.textContent = localTranslations.get(key);
      return;
    }
    if (!explicit && document.hidden) return;
    if (translating) {
      queued = true;
      return;
    }
    translating = true;
    try {
      if (!(await accepted(key)) || ref !== revision) return;
      const local=await device.translate(key);
      if(ref!==revision || disposed)return;
      if(local){if(localTranslations.size>=100)localTranslations.delete(localTranslations.keys().next().value);localTranslations.set(key,local);translation.textContent=local;return;}
      if(!explicit && (scope || observed || mode.value==='lyrics' || remoteBudget<=0))return;
      if(!explicit)remoteBudget--;
      if (!(await allowShare(scope, key, 'lexical', 'English Coach và dịch vụ dịch máy')) || ref !== revision)
        return;
      const r = await send({ t: 'media:translate', text: key });
      if (disposed || ref !== revision) return;
      if (r?.data) {
        if (localTranslations.size >= 100) localTranslations.delete(localTranslations.keys().next().value);
        localTranslations.set(key, r.data.translation);
        translation.textContent = r.data.translation;
      } else notify(r?.error?.message || 'Chưa dịch được câu này.');
    } finally {
      translating = false;
      if (queued) {
        queued = false;
        if (!disposed && bilingual.checked) translateLine(false);
      }
    }
  }
  function target() {
    return words.value.trim() || line()?.text || '';
  }
  async function lookup() {
    const q = target(),
      ref = revision;
    if (
      !q ||
      !(await accepted(q)) ||
      !(await allowShare(scope, q, 'lexical', 'từ điển English Coach')) ||
      ref !== revision
    )
      return;
    if (q.split(/\s+/).length > 4) {
      await translateLine(true);
      return;
    }
    const r = await send({ t: 'lookup', word: q });
    if (ref !== revision || disposed || target()!==q) return;
    if (r?.data) {
      word = r.data.headword || q;
      ipa.textContent =
        r.data.pronunciations
          ?.map((x) => x.ipa)
          .filter(Boolean)
          .join(' · ') || '';
      out.replaceChildren(dictionaryView(r.data, q));
    } else out.replaceChildren(errorView(r?.error));
  }
  async function save() {
    const q = target(),
      ref = revision;
    if (!q || q.length > 120 || q.split(/\s+/).length > 12) {
      notify('Chọn một từ hoặc cụm ngắn để lưu.');
      return;
    }
    if (
      !(await accepted(q)) ||
      !(await allowShare(scope, q, 'save', 'English Coach để dịch và lưu Flashcard')) ||
      ref !== revision
    )
      return;
    const lexical=q.split(/\s+/).length<=4?(await send({t:'lookup',word:q}))?.data:null;
    if(ref!==revision)return;
    const back=lexical?.generalTranslationVi || lexical?.vietnameseSenses?.[0]?.meanings?.[0];
    const meaning = back?{data:{translation:back}}:await send({ t: 'translate', text: q });
    if (!meaning?.data || ref !== revision) {
      if (meaning?.error) notify(meaning.error.message);
      return;
    }
    const r = await send({
      t: 'save',
      item: { front: q, back: meaning.data.translation, ipa:lexical?.pronunciations?.[0]?.ipa,example:scope?null:line()?.text?.slice(0,1000), omitSource: true },
    });
    notify(r?.data ? 'Đã lưu vào Thẻ từ vựng.' : r?.error?.message || 'Chưa lưu được.');
  }
  async function ai(kind) {
    const q = line()?.text?.slice(0, 600),
      ref = revision,
      acct = getAccount();
    if (!q || !(await accepted(q))) return;
    if (!acct?.premium) {
      notify('Echo AI cần tài khoản Premium đang hoạt động.');
      return;
    }
    const key = JSON.stringify([acct.account?.id, kind, q]);
    if (aiPending.size) return;
    if (aiResults.has(key)) {
      out.replaceChildren(aiView(aiResults.get(key)));
      return;
    }
    aiPending.add(key);
    try {
      if (!(await allowShare(scope, q, 'ai', 'English Coach và nhà cung cấp Echo AI')) || ref !== revision)
        return;
      notify('Đang giải thích đoạn đã chọn…');
      const r = await send({ t: 'ai', req: { action: 'ask', text: q, question: questions[kind] } });
      if (r?.data && ref === revision && !disposed) {
        if (aiResults.size >= 12) aiResults.delete(aiResults.keys().next().value);
        aiResults.set(key, r.data);
      }
      if (ref === revision && !disposed) out.replaceChildren(r?.data ? aiView(r.data) : errorView(r?.error));
    } finally {
      aiPending.delete(key);
    }
  }
  async function batchTranslate(){
    if(!line() || document.hidden)return;
    const epoch=++batchEpoch, block=cues.slice(index,index+3), unique=[...new Set(block.filter(c=>!vietnamese.some(v=>Number.isFinite(v.start)&&v.start<c.end&&v.end>c.start)).map(c=>c.text))];
    // Review exactly what could leave the device, including on private surfaces.
    for(const q of unique){
      if(epoch!==batchEpoch || disposed || document.hidden)return;
      if(localTranslations.has(q) || !(await accepted(q)))continue;
      let value=await device.translate(q);
      if(!value){
        if(epoch!==batchEpoch || document.hidden || !(await allowShare(scope,q,'lexical','English Coach và dịch vụ dịch máy')) || epoch!==batchEpoch)return;
        const r=await send({t:'media:translate',text:q});value=r?.data?.translation;
      }
      if(epoch!==batchEpoch || disposed)return;
      if(value){if(localTranslations.size>=100)localTranslations.delete(localTranslations.keys().next().value);localTranslations.set(q,value);}
    }
    bilingual.checked=true;translateLine(false);notify('Đã xử lý tối đa ba câu.');
  }
  function drawChapters(){
    const times=chapterData.length?chapterData:cues.filter((c,n)=>Number.isFinite(c.start) && n%8===0).slice(0,60).map(c=>({start:c.start,title:c.text.slice(0,84)}));
    const list=[...times];
    for(const c of aiChapters.values()){const i=list.findIndex(x=>x.start===c.start);if(i>=0)list[i]=c;else list.push(c);}
    chapterBox.replaceChildren(h('p',{class:'muted small',text:chapterData.length?'Chương từ trình phát':'Mốc học từ phụ đề'}),...list.sort((a,b)=>a.start-b.start).map(c=>h('div',{},button(timeLabel(c.start)+' · '+c.title,()=>{if(!attached)return notify('Mốc này cần trình phát được kết nối.');exerciseActive=false;manual=false;follow.checked=true;post({type:'seek',start:c.start});}),c.summary?h('p',{text:c.summary}):null,c.vocab?h('small',{text:c.vocab}):null)));
  }
  async function sectionAI(kind){
    if(!line())return notify('Chưa có đoạn phụ đề. Hãy bật CC hoặc nhập trích đoạn.');
    const acct=getAccount();
    if(!acct?.premium)return notify('Echo AI cần tài khoản Premium đang hoạt động.');
    if(kind==='ask' && !question.value.trim())return notify('Nhập câu hỏi về đoạn này.');
    if(kind==='chapter' && !Number.isFinite(line().start))return notify('Tạo chương cần phụ đề có mốc thời gian.');
    manual=true;const first=line(), block=cues.slice(index,index+8),limit=kind==='ask'?1400:2000;
    const excerpt=block.map(c=>c.text).join('\n').slice(0,limit),ref=sourceEpoch;
    const action=kind==='chapter'?'summarize':kind;
    if(action!=='ask' && excerpt.length<200)return notify('Đoạn này cần ít nhất 200 ký tự để tóm tắt hoặc tạo quiz. Chọn mốc sớm hơn hay dùng Hỏi đoạn này.');
    const prompt=kind==='ask'?('Dựa riêng vào đoạn được trích. Nếu không có bằng chứng, nói rõ. '+question.value.trim()).slice(0,450):null;
    const req={action,text:excerpt,question:prompt,count:3};
    const key=JSON.stringify([acct.account?.id,req]);
    if(aiPending.size)return notify('Đang xử lý yêu cầu trước.');
    let data=aiResults.get(key);
    if(!data){
      aiPending.add(key);
      try{
        if(!(await accepted(excerpt)) || !(await allowShare(scope,kind==='ask'?excerpt+'\n'+question.value:excerpt,'ai','English Coach và nhà cung cấp Echo AI')) || ref!==sourceEpoch || disposed)return;
        notify('Đang đọc đoạn đã chọn…');
        const r=await send({t:'ai',req});if(disposed || ref!==sourceEpoch)return;
        if(!r?.data){out.replaceChildren(errorView(r?.error));return;}data=r.data;
        if(aiResults.size>=12)aiResults.delete(aiResults.keys().next().value);aiResults.set(key,data);
      }finally{aiPending.delete(key);}
    }
    if(kind==='chapter'){
      if(aiChapters.size>=24 && !aiChapters.has(first.start))aiChapters.delete(aiChapters.keys().next().value);
      aiChapters.set(first.start,{start:first.start,title:data.mainIdea?.slice(0,100)||first.text.slice(0,80),summary:data.summary?.[0],vocab:data.keyVocabulary?.map(v=>v.term).slice(0,4).join(' · ')});drawChapters();
    }
    out.replaceChildren(h('details',{},h('summary',{text:'Phụ đề nguồn · '+timeLabel(first.start)}),h('p',{text:excerpt})),kind==='quiz'?quizView(data.questions||[]):aiView(data));notify('Đã trả lời theo đoạn phụ đề được chọn.');
  }
  function control(loop, seek) {
    const c = line();
    if (!attached || !Number.isFinite(c?.start)) {
      if (seek) notify('Câu này chưa có mốc thời gian hoặc trình phát đã ngắt.');
      return;
    }
    post({ type: 'segment', start: c.start, end: c.end, loop, pause: autoPause.checked, seek });
  }
  function importText(text) {
    try {
      if (mode.value === 'lyrics' && !text.includes('-->') && text.length > 800) {
        notify('Hãy dùng trích đoạn lời nhạc tối đa 800 ký tự.');
        return;
      }
      const parsed = parseCues(text);
      if (!parsed.length) {
        notify('Không đọc được mốc thời gian. Kiểm tra tệp SRT/VTT.');
        return;
      }
      if (importLang.value === 'vi') {
        if (!cues.length) {
          notify('Nhập phụ đề tiếng Anh trước.');
          return;
        }
        vietnamese = parsed.map((c, i) =>
          Number.isFinite(c.start) ? c : { ...c, start: cues[i]?.start, end: cues[i]?.end },
        );
        bilingual.checked = true;
        translateLine(true);
        notify('Đã ghép phụ đề tiếng Việt trên máy.');
        return;
      }
      clearSource();
      custom = true;
      cues = parsed;drawChapters();
      manual = !Number.isFinite(cues[0].start);
      display(0);
      notify('Đã nhập ' + cues.length + ' câu trên thiết bị.');
    } catch (e) {
      notify(e.message);
    }
  }
  async function listenForMeaning(){
    const c=line(),ref=revision;
    if(!c || !(await accepted(c.text)) || ref!==revision)return;
    const pairs=cues.map(x=>({source:x,meaning:vietnamese.find(v=>Number.isFinite(x.start) && v.end>x.start && v.start<x.end)?.text || localTranslations.get(x.text)}));
    const correct=pairs.find(x=>x.source===c)?.meaning;
    const distractors=[...new Set(pairs.map(x=>x.meaning).filter(x=>x && x!==correct))].slice(0,2);
    if(!correct || !distractors.length)return notify('Cần ít nhất hai câu có bản dịch khác nhau. Hãy ghép phụ đề Việt hoặc bấm Dịch 3 câu.');
    manual=true;exerciseActive=true;caption.hidden=true;transcriptPage.hidden=true;translation.textContent='';ipa.textContent='';out.replaceChildren();words.value='';redrawOverlay();
    const opts=[...distractors];opts.splice((index+1)%(opts.length+1),0,correct);
    const verdict=h('p',{role:'status'}),options=row();
    for(const label of opts)options.append(button(label,async()=>{for(const b of options.children)b.disabled=true;const ok=label===correct;verdict.textContent=ok?'Chính xác.':'Ý của câu: '+correct;await send({t:'media:progress',correct:ok});}));
    const replay=()=>attached && Number.isFinite(c.start)?control(false,true):speak(c.text,!!scope);
    drill.replaceChildren(h('h3',{text:'Câu vừa nghe diễn đạt ý nào?'}),button('Nghe lại',replay),options,verdict,button('Xem lại câu',endDrill));replay();
  }
  async function practice(kind) {
    const c = line(),
      ref = revision;
    if (!c || !(await accepted(c.text)) || ref !== revision) return;
    const task = exercise(c.text, kind);
    if (!task) return;
    manual = true;
    exerciseActive = true;
    translation.textContent = '';
    ipa.textContent = '';
    caption.hidden = true;redrawOverlay();
    transcriptPage.hidden = true;
    out.replaceChildren();
    words.value = '';
    const answer = h('input', { 'aria-label': 'Câu trả lời', placeholder: 'Nhập đáp án' });
    const result = h('p', { role: 'status' }),
      tiles = row(),
      picks = [];
    if (task.tiles)
      for (const w of task.tiles) {
        const b = button(w, () => {
          picks.push(w);
          b.disabled = true;
          answer.value = picks.join(' ');
        });
        tiles.append(b);
      }
    let scored = false;
    drill.replaceChildren(
      h('h3', { text: kind === 'blank' ? 'Điền từ' : kind === 'order' ? 'Xếp lại câu' : 'Chép chính tả' }),
      h('p', { text: task.prompt || 'Chọn các từ theo thứ tự.' }),
      tiles,
      answer,
      row(
        button('Nghe lại', () => {
          if (attached && Number.isFinite(c.start)) control(false, true);
          else speak(c.text, !!scope);
        }),
        button(
          'Kiểm tra',
          async () => {
            const ok = normalizeAnswer(answer.value) === task.answer;
            result.textContent = ok ? 'Chính xác.' : 'Đáp án: ' + task.answer;
            if (!scored) {
              scored = true;
              const r = await send({ t: 'media:progress', correct: ok });
              if (r?.data) result.textContent += ' · Trên thiết bị: ' + r.data.correct + '/' + r.data.total;
            }
          },
          true,
        ),
        button('Xem lại câu', endDrill),
      ),
      result,
    );
  }
  function endDrill() {
    exerciseActive = false;
    caption.hidden = false;
    transcriptPage.hidden = false;
    drill.replaceChildren();
    if (line()) display(index);
  }
  async function record() {
    const c = line();
    if (!c || recordStream || !(await accepted(c.text))) return;
    manual = true;
    const serial = ++recordingRequest;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed || serial !== recordingRequest) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      recordStream = stream;
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (disposed || c !== line()) return;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
        recordOut.append(h('audio', { controls: true, src: audioUrl, 'aria-label': 'Bản đọc trên máy' }));
      };
      recorder.start();
      recordStatus.textContent = 'Đang thu mic trên thiết bị · tối đa 20 giây';
      recordTimer = setTimeout(stopMic, 20000);
      const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
      if (
        Rec?.available &&
        (await Rec.available({ langs: ['en-US'], processLocally: true })) === 'available' &&
        serial === recordingRequest
      ) {
        recognizer = new Rec();
        recognizer.processLocally = true;
        recognizer.lang = 'en-US';
        recognizer.onresult = (e) => {
          const heard = e.results[0][0].transcript;
          recordOut.append(
            h('p', {
              text:
                'Máy nghe được: ' +
                heard +
                ' · ' +
                (normalizeAnswer(heard) === normalizeAnswer(c.text)
                  ? 'Khớp câu mẫu.'
                  : 'Hãy nghe lại và đối chiếu câu mẫu.'),
            }),
          );
        };
        recognizer.start();
      }
    } catch (e) {
      if (!recorder || recorder.state !== 'recording') stopMic();
      notify('Thiết bị chưa cho phép ghi hoặc nhận dạng. Bạn có thể mở Luyện nói trên English Coach.');
    }
  }
  bilingual.onchange = () => {
    if (bilingual.checked) {remoteBudget=2;translateLine(true);}
    else {
      translation.textContent = '';
      revision++;batchEpoch++;
      send({ t: 'media:cancel' });
    }
  };
  speed.onchange = () => post({ type: 'rate', rate: Number(speed.value) });
  autoPause.onchange = () => {
    if (autoPause.checked) control(false, false);
    else post({ type: 'clear' });
  };
  follow.onchange = () => {
    manual = !follow.checked;
    if (!manual && cueIndex(cues, activeTime) >= 0) display(cueIndex(cues, activeTime));
  };
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) {
      notify('Giới hạn tệp là 1 MB.');
      return;
    }
    importText(await f.text());
  };
  const lbl = (el, label) => h('label', {}, el, ' ' + label);
  async function phonetics() {
    const text = line()?.text,
      ref = revision;
    if (
      !text ||
      !(await accepted(text)) ||
      !(await allowShare(scope, text, 'lexical', 'từ điển English Coach để xem IPA'))
    )
      return;
    const parts = (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).slice(0, 14);
    const found = new Map();
    for (const token of new Set(parts.map((t) => t.toLowerCase()))) {
      if (ref !== revision || disposed) return;
      const r = await send({ t: 'lookup', word: token });
      found.set(token, r?.data?.pronunciations?.[0]?.ipa || token);
    }
    if (ref === revision) ipa.textContent = parts.map((t) => found.get(t.toLowerCase())).join(' ');
  }
  const size = select('Cỡ phụ đề', [
    [18, 'Nhỏ'],
    [22, 'Vừa'],
    [28, 'Lớn'],
  ]);
  size.value = '22';
  size.onchange = () => {card.style.setProperty('--cue-size',size.value+'px');redrawOverlay();};
  overlay.onchange=redrawOverlay;view.onchange=()=>{renderTranscript();transcript.style.maxHeight=view.value==='transcript'?'65vh':'';};
  trObserver.observe(translation,{childList:true,characterData:true,subtree:true});
  const consentText = h('p', {
    class: 'muted small',
    text: 'Chỉ dùng phụ đề hoặc lời bạn có quyền học. Dịch máy gửi câu đang cần đến English Coach. Echo AI chỉ nhận đoạn bạn bấm giải thích.',
  });
  const aiQuota = h('p', {
    class: 'muted small',
    text: getAccount()?.ai
      ? 'Echo AI · còn ' + getAccount().ai.remaining + '/' + getAccount().ai.limit + ' lượt tháng này'
      : 'Giải thích sâu dùng hạn mức Echo AI Premium.',
  });
  function actions() {
    endDrill();
    tools.replaceChildren(
      words,
      row(
        button('Tra nghĩa / IPA', lookup),
        mt,
        button('Lưu Flashcard', save),
        button('Cosmos', async () => {
          const q = target();
          if (
            q &&
            (await accepted(q)) &&
            (await allowShare(scope, q, 'cosmos', 'Vũ trụ tri thức English Coach'))
          )
            await send({ t: 'cosmos', word: q.split(/\s+/)[0] });
        }),
      ),
      aiQuota,
    );
    if (mode.value === 'lyrics')
      tools.append(
        h('h3', { text: 'Echo Lyrics Lab' }),
        row(
          button('Nghĩa tự nhiên', () => ai('natural')),
          button('Ẩn dụ và sắc thái', () => ai('metaphor')),
          button('Ngữ pháp', () => ai('grammar')),
          button('Nối âm', () => ai('sound')),
        ),
      );
    else
      tools.append(
        row(
          button('Giải thích câu · Premium', () => ai('natural')),
          button('Ngữ pháp · Premium', () => ai('grammar')),
        ),
      );
  }
  mode.onchange = actions;
  actions();
  const reconnect = button('Kết nối trình phát', attach);
  const step = (d) => {
    endDrill();
    manual = true;
    display(Math.max(0, Math.min(cues.length - 1, index + d)));
  };
  card.append(
    row(mode, reconnect),row(view,lbl(overlay,'Hiện trên video')),readTranscript,
    caption,
    translation,
    ipa,
    row(
      button('Câu trước', () => step(-1)),
      button('Câu sau', () => step(1)),
      button('Phát câu', () => control(false, true)),
      button('Lặp câu A–B', () => control(true, true)),
      button('Dừng lặp', () => post({ type: 'clear' })),
    ),
    row(
      speed,
      size,
      button('Tương phản', () => card.classList.toggle('strong-contrast')),
    ),
    row(lbl(bilingual, 'Song ngữ'), lbl(autoPause, 'Dừng cuối câu'), lbl(follow, 'Theo trình phát')),
    status,
  );
  card.append(row(button('Bật dịch trên thiết bị',async()=>{
    const t=await device.ready(true,notify);notify(t?'Dịch Anh → Việt trên thiết bị đã sẵn sàng.':'Trình duyệt chưa có gói Anh → Việt. Bạn vẫn có thể dịch từng câu.');
  }),button('Dịch 3 câu',batchTranslate)));
  const material = h(
    'details',
    {},
    h('summary', { text: 'Dùng phụ đề hoặc lời của bạn' }),
    consentText,
    importLang,
    file,
    source,
    button('Dùng văn bản', () => importText(source.value), true),
    button('Học trích đoạn đã chọn', async () => {
      const r = await send({ t: 'media:selection', tabId });
      if (!r?.data) {
        notify(r?.error?.message || 'Hãy tự dán trích đoạn.');
        return;
      }
      scope = r.data.scope;
      importLang.value = 'en';
      importText(r.data.text);
    }),
  );
  card.append(button('Xem IPA câu đang chọn', phonetics));
  card.append(
    row(
      button('Đặt A', () => {
        if (attached) {
          pointA = activeTime;
          notify('Điểm A · ' + timeLabel(pointA));
        }
      }),
      button('Đặt B và lặp', () => {
        if (!attached || pointA === null || activeTime <= pointA) {
          notify('Đặt A, phát đến cuối đoạn rồi đặt B.');
          return;
        }
        manual = true;
        post({ type: 'segment', start: pointA, end: activeTime, loop: true, seek: true });
      }),
    ),
  );
  const speech = h(
    'details',
    {},
    h('summary', { text: 'Luyện phát âm và nhận dạng cục bộ' }),
    h('p', {
      class: 'muted small',
      text: 'Thu giọng của bạn trên thiết bị để nghe lại. Nhận dạng câu cần gói tiếng Anh cục bộ. Âm thanh không được tải lên.',
    }),
    row(button('Thu giọng của tôi', record), button('Dừng mic', stopMic)),
    recordStatus,
    recordOut,
    button('Sao chép câu và mở Kiểm tra phát âm', async () => {
      const text = line()?.text;
      if (!text || !(await accepted(text))) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        notify('Hãy tự sao chép câu mẫu.');
      }
      await send({ t: 'open', path: '/speaking?mode=assessment' });
    }),
    h('p', {
      class: 'muted small',
      text: 'Với âm thanh cùng nguồn bạn sở hữu, có thể nhận dạng tối đa 30 giây nếu thiết bị hỗ trợ.',
    }),
    row(
      button('Nhận dạng đoạn của tôi', () => {
        if (
          window.confirm(
            'Bạn có quyền xử lý âm thanh này và muốn nhận dạng trên thiết bị trong tối đa 30 giây?',
          )
        )
          post({ type: 'recognize' });
      }),
      button('Dừng nhận dạng', () => post({ type: 'stop-asr' })),
    ),
  );
  panel.replaceChildren(
    card,
    material,
    tools,
    h('details',{},h('summary',{text:'Ask Echo và chương video'}),h('p',{class:'muted small',text:'Mỗi yêu cầu dùng tối đa 8 câu kể từ câu đang chọn. Chương có sẵn và mốc phụ đề không dùng AI.'}),question,row(button('Hỏi đoạn này',()=>sectionAI('ask')),button('Tóm tắt và từ vựng',()=>sectionAI('summarize')),button('Quiz đọc hiểu',()=>sectionAI('quiz')),button('Tạo chương cho đoạn',()=>sectionAI('chapter'))),chapterBox),
    out,
    h(
      'div',
      { class: 'card stack' },
      h('h3', { text: 'Karaoke · luyện nghe' }),
      row(
        button('Điền từ', () => practice('blank')),
        button('Chép chính tả', () => practice('dictation')),
        button('Xếp câu', () => practice('order')),button('Nghe hiểu',listenForMeaning),
      ),
      drill,
      speech,
    ),
    h('div', { class: 'card stack' }, h('h3', { text: 'Phụ đề' }), transcriptPage),
  );
  const shortcuts=e=>{if(!e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input,textarea,select') || !panel.isConnected || panel.hidden)return;
    if(e.key==='ArrowRight' || e.key==='ArrowLeft'){e.preventDefault();step(e.key==='ArrowRight'?1:-1);control(false,true);}else if(e.key.toLowerCase()==='r'){e.preventDefault();control(true,true);}};
  card.append(h('small',{class:'muted',text:'Trong bảng học'+' · Alt + ← / →: phát câu trước / sau · Alt + R: lặp câu'}));
  document.addEventListener('keydown',shortcuts);
  attach();
  const hide = () => {
    redrawOverlay();if (document.hidden) {
      batchEpoch++;stopMic();
      post({ type: 'stop-asr' });
      send({ t: 'media:cancel' });
    }
  };
  document.addEventListener('visibilitychange', hide);
  return () => {
    disposed = true;resetDevice();trObserver.disconnect();clearTimeout(reconnectTimer);document.removeEventListener('keydown',shortcuts);
    generation++;
    revision++;
    document.removeEventListener('visibilitychange', hide);
    stopMic();
    port?.disconnect();
    port = null;
    send({ t: 'media:cancel' });
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    panel.replaceChildren();
  };
}
