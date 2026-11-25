import type { RushTopic } from '@/types/quizRush';
export const rushTopicLabel=(topic:string,vi:boolean):string=>{
  const labels:Record<RushTopic,[string,string]>={
    MIXED:['Kết hợp','Mixed'],VOCABULARY:['Từ vựng','Vocabulary'],WORD_RELATIONS:['Đồng nghĩa, trái nghĩa và họ từ','Synonyms, antonyms and word families'],SPELLING:['Chính tả','Spelling'],
    GRAMMAR:['Ngữ pháp và từ loại','Grammar and Parts of Speech'],WORD_USE:['Kết hợp từ và cụm từ','Collocations and expressions'],
    PHRASAL_VERBS:['Cụm động từ','Phrasal Verbs'],IDIOMS_EXPRESSIONS:['Thành ngữ và cách diễn đạt','Idioms and Expressions'],
  };
  return labels[topic as RushTopic]?.[vi?0:1]??topic;
};
