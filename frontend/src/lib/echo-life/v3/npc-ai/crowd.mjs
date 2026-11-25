/** Low-cost background schedules. People walk a continuous rectangular sidewalk loop.
 * Only the nearest four acquire a skinned model. Far positions are analytic in game time. */
export function crowdAt(clock){
 const people=[];
 for(let i=0;i<80;i++){
  const blockX=((i%10)-5)*20,blockZ=(Math.floor(i/10)-4)*20;
  const offset=(clock*(1+(i%7)*.025)+i*3.7)%88;
  // Eight minutes of the loop are spent waiting at the crossing.
  const t=Math.min(79.999,offset),leg=Math.floor(t/20),u=t%20;
  const [dx,dz,yaw]=[[u,0,Math.PI/2],[20,u,0],[20-u,20,-Math.PI/2],[0,20-u,Math.PI]][leg];
  people.push({id:i,x:blockX+dx+.9,z:blockZ+dz+.95,yaw,pose:offset>=80?'idle':'walk'});
 }return people;
}

