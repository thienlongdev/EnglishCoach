/** Original editable Canvas artwork; no downloaded assets. Geometry matches the painted teal/gold world. */
export function drawRushEffect(ctx:CanvasRenderingContext2D,kind:string,x:number,y:number,size:number,time:number,reduced:boolean){
  if(!kind)return;ctx.save();ctx.translate(x,y-size*.38);ctx.lineJoin='round';ctx.lineCap='round';
  const pulse=reduced?1:1+Math.sin(time*.004)*.045;ctx.scale(pulse,pulse);
  if(kind==='ICE_LOCK'){
    ctx.strokeStyle='#f0ffff';ctx.lineWidth=3;ctx.fillStyle='#68c5dc30';ctx.beginPath();
    for(let i=0;i<8;i++){const a=i*Math.PI/4,r=size*(i%2?.39:.46);const px=Math.cos(a)*r,py=Math.sin(a)*r*.72;if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);}ctx.closePath();ctx.fill();ctx.stroke();
    ctx.strokeStyle='#236e93';ctx.lineWidth=1.5;for(let i=0;i<6;i++){const a=i*Math.PI/3;ctx.beginPath();ctx.moveTo(Math.cos(a)*size*.34,Math.sin(a)*size*.25);ctx.lineTo(Math.cos(a)*size*.45,Math.sin(a)*size*.35);ctx.stroke();}
  }else if(kind==='TIME_SNARE'){
    ctx.strokeStyle='#e7bd74';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(0,0,size*.43,size*.28,0,0,Math.PI*2);ctx.stroke();ctx.strokeStyle='#183f61';ctx.lineWidth=2;
    for(let i=0;i<12;i++){const a=i*Math.PI/6;ctx.beginPath();ctx.moveTo(Math.cos(a)*size*.35,Math.sin(a)*size*.22);ctx.lineTo(Math.cos(a)*size*.40,Math.sin(a)*size*.26);ctx.stroke();}
    ctx.fillStyle='#fff4d7';ctx.beginPath();ctx.moveTo(-8,-size*.65);ctx.lineTo(8,-size*.65);ctx.lineTo(-7,-size*.44);ctx.lineTo(7,-size*.44);ctx.closePath();ctx.fill();ctx.stroke();
  }else if(kind==='POSITION_SWAP'){
    for(let i=0;i<2;i++){ctx.strokeStyle=i?'#eed199':'#1c91a1';ctx.lineWidth=4;ctx.beginPath();const a=(reduced?0:time*.006)+i*Math.PI;ctx.arc(0,0,size*.43,a,a+Math.PI*.8);ctx.stroke();const end=a+Math.PI*.8;ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(Math.cos(end)*size*.43,Math.sin(end)*size*.43,4,0,Math.PI*2);ctx.fill();}
  }ctx.restore();
}
