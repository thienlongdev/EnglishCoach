/** Presentation only. Never changes world positions or infers an answer. */
export const racerColor = (id: string) => ['#e8c473','#df957c','#ac9fc9','#82b5d5','#75c6b7'][Math.max(0,Number(id.slice(1))-1)%5];
export function wrapGateText(text: string, max: number, measure: (text: string) => number): string[] {
  const lines: string[]=[];let line='';
  for(const word of text.split(/\s+/u)){
    if(line&&measure(line+' '+word)>max){lines.push(line);line='';}
    if(measure(word)>max){
      if(line){lines.push(line);line='';}
      for(const char of Array.from(word)){if(line&&measure(line+char)>max){lines.push(line);line='';}line+=char;}
    }else line=line?line+' '+word:word;
  }
  if(line)lines.push(line);return lines;
}
