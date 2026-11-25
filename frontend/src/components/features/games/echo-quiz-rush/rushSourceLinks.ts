/** Source metadata can be nested; restrict links to existing HTTPS attribution. */
export function rushSourceLinks(raw?:string|null):string[]{
  if(!raw)return [];const links=new Set<string>();
  const visit=(value:unknown,depth=0)=>{if(depth>5||links.size>=8)return;if(typeof value==='string'&&value.startsWith('https://')){try{links.add(new URL(value).href);}catch{}}else if(Array.isArray(value))value.forEach(v=>visit(v,depth+1));else if(value&&typeof value==='object')Object.values(value).forEach(v=>visit(v,depth+1));};
  try{visit(JSON.parse(raw));}catch{}return [...links];
}
