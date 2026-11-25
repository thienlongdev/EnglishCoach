import * as T from 'three';
import type { WindowView } from '@/lib/study-space/types';

/**
 * The living view behind a room's window: one shader with a scene per view (ocean with a passing whale and jellyfish,
 * rain over a night city, a twilight castle sky, deep space with a ringed planet, day / sunset / night skies). It
 * runs on the scene clock, so it slows with the rest of the room and freezes under reduced motion.
 */

const VIEWS: WindowView[] = ['ocean', 'rain', 'magic', 'space', 'day', 'sunset', 'night', 'live'];

let latchAudio: AudioContext | null = null;
/** The latch and a breath of air: made here, from a press, never a file and never before a gesture. */
export function windowLatch(open: boolean) {
  try {
    latchAudio ??= new AudioContext();
    const c = latchAudio, now = c.currentTime;
    void c.resume();
    const click = c.createOscillator(), clickGain = c.createGain();
    click.type = 'triangle'; click.frequency.setValueAtTime(open ? 420 : 300, now); click.frequency.exponentialRampToValueAtTime(90, now + .07);
    clickGain.gain.setValueAtTime(.05, now); clickGain.gain.exponentialRampToValueAtTime(.0001, now + .09);
    click.connect(clickGain).connect(c.destination); click.start(now); click.stop(now + .1);
    const seconds = open ? .9 : .35, frames = Math.floor(c.sampleRate * seconds), buffer = c.createBuffer(1, frames, c.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / frames);
    const air = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    air.buffer = buffer; filter.type = 'lowpass'; filter.frequency.value = open ? 900 : 500; gain.gain.value = open ? .018 : .01;
    air.connect(filter).connect(gain).connect(c.destination); air.start(now + .04);
  } catch { /* No audio here: the window still opens. */ }
}

const frag = /* glsl */ `
precision highp float;
uniform float uTime; uniform int uView; uniform vec2 uAspect; uniform float uRain; uniform float uSun; uniform float uArc;
varying vec2 vUv;
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y); }
float fbm(vec2 p){ float v=0.,a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=.5; } return v; }
float stars(vec2 uv, float density, float t){ vec2 g=floor(uv*density), f=fract(uv*density)-.5; float r=h21(g);
  float s=smoothstep(.06,0.,length(f-vec2(r-.5,fract(r*7.)-.5)*.6))*step(.78,r); return s*(.6+.4*sin(t*2.+r*40.)); }
float ellipse(vec2 p, vec2 c, vec2 r){ vec2 d=(p-c)/r; return dot(d,d); }
float whale(vec2 p){
  float body=smoothstep(1.,.85,ellipse(p,vec2(0.),vec2(.22,.075)));
  vec2 q=p-vec2(.22,.0); float tail=smoothstep(.02,0.,abs(q.y-sin(q.x*18.)*.03)-max(0.,.06-q.x*.3))*step(0.,q.x)*step(q.x,.13);
  float fluke=smoothstep(1.,.7,ellipse(p,vec2(.34,.035),vec2(.05,.02)))+smoothstep(1.,.7,ellipse(p,vec2(.34,-.035),vec2(.05,.02)));
  float fin=smoothstep(1.,.7,ellipse(p,vec2(-.02,-.07),vec2(.06,.02)));
  return clamp(body+tail+fluke+fin,0.,1.); }
vec3 ocean(vec2 uv,float t){
  vec3 c=mix(vec3(.05,.12,.35),vec3(.25,.55,.95),uv.y);
  float rays=0.; for(int i=0;i<5;i++){ float x=uv.x*1.6-float(i)*.37+sin(t*.2+float(i))*.05; rays+=smoothstep(.06,0.,abs(fract(x+uv.y*.35)-.5))*.12; }
  c+=rays*vec3(.6,.85,1.)*uv.y;
  float ca=fbm(uv*vec2(6.,3.)+vec2(t*.15,-t*.1)); c+=pow(ca,3.)*.25*vec3(.7,.9,1.)*smoothstep(.3,1.,uv.y);
  vec2 wp=vec2(mod(t*.035,1.8)-.9+.5,.55+sin(t*.25)*.03); float w=whale((uv-wp)*vec2(uAspect.x,1.)*vec2(-1.,1.));
  c=mix(c,vec3(.55,.75,1.)*(.7+.3*uv.y),w*.85);
  for(int i=0;i<4;i++){ float fi=float(i); vec2 jp=vec2(fract(.2+fi*.27+sin(t*.05+fi)*.03),fract(.15+fi*.2+t*.02*(1.+fi*.2)));
    float j=exp(-ellipse(uv,jp,vec2(.025,.02))*1.5); c+=j*vec3(.9,.6,1.)*.6; }
  for(int i=0;i<12;i++){ float fi=float(i); vec2 bp=vec2(fract(fi*.137+.05),fract(fi*.31+t*(.03+fract(fi*.7)*.04)));
    float b=smoothstep(.012,.006,length((uv-bp)*vec2(uAspect.x,1.))); c+=b*.35; }
  float coral=smoothstep(.0,.05,.12+fbm(vec2(uv.x*8.,1.))*.12-uv.y); c=mix(c,vec3(.95,.55,.75)*.6,coral);
  return c; }
vec3 rain(vec2 uv,float t){
  vec3 c=mix(vec3(.04,.05,.14),vec3(.18,.2,.38),uv.y);
  float sky=smoothstep(.3,1.,uv.y); c+=fbm(uv*3.+t*.02)*.06*sky;
  for(int i=0;i<16;i++){ float fi=float(i); float x=fract(fi*.173+.03), hgt=.15+fract(fi*.61)*.35, w=.04+fract(fi*.37)*.06;
    float b=step(abs(uv.x-x),w)*step(uv.y,hgt); c=mix(c,vec3(.07,.07,.16),b);
    vec2 cell=floor(vec2((uv.x-x+w)/.012,uv.y/.02)); float win=step(.62,h21(cell+fi))*b*step(fract((uv.x-x+w)/.012),.6)*step(fract(uv.y/.02),.55);
    c+=win*mix(vec3(1.,.8,.45),vec3(.6,.75,1.),h21(cell))*.55; }
  for(int i=0;i<14;i++){ float fi=float(i); vec2 p=vec2(fract(fi*.29+.1),.12+fract(fi*.53)*.25); float r=.02+fract(fi*.7)*.03;
    c+=exp(-ellipse(uv,p,vec2(r)))*mix(vec3(1.,.7,.4),vec3(.7,.6,1.),fract(fi*.33))*.18; }
  vec2 ruv=uv*vec2(60.,1.); float col=floor(ruv.x); float sp=1.2+h21(vec2(col,3.))*1.5; float y=fract(uv.y*3.+t*sp+h21(vec2(col,1.)));
  float streak=smoothstep(.0,.02,y)*smoothstep(.12,.02,y)*step(.6,h21(vec2(col,7.)))*smoothstep(.4,.5,abs(fract(ruv.x)-.5)*2.);
  c+=streak*.25*vec3(.7,.8,1.);
  vec2 g=floor(uv*vec2(18.,12.)); float d=h21(g); vec2 f=fract(uv*vec2(18.,12.))-.5; float slide=fract(t*.05*d+d);
  float drop=smoothstep(.12,.06,length((f-vec2(0.,.4-slide*.8))*vec2(1.,1.4)))*step(.82,d); c+=drop*.3;
  return c; }
vec3 magic(vec2 uv,float t){
  vec3 c=mix(vec3(.98,.75,.85),vec3(.32,.28,.75),pow(uv.y,.7)); c+=stars(uv,40.,t)*smoothstep(.4,.9,uv.y);
  c=mix(c,vec3(1.,.97,.85),smoothstep(.06,.05,length((uv-vec2(.78,.78))*vec2(uAspect.x,1.))));
  float cl=fbm(vec2(uv.x*3.+t*.01,uv.y*6.)); c=mix(c,vec3(1.,.88,.95),smoothstep(.55,.8,cl)*smoothstep(.55,.25,uv.y)*.8);
  float castle=step(uv.y,.32+step(abs(uv.x-.35),.03)*.12+step(abs(uv.x-.46),.02)*.18+step(abs(uv.x-.55),.03)*.1+step(abs(uv.x-.45),.12)*.05)*step(abs(uv.x-.45),.15);
  c=mix(c,vec3(.35,.3,.6),castle*.9); float isl=smoothstep(1.,.8,ellipse(uv,vec2(.75,.4+sin(t*.3)*.01),vec2(.12,.03)));
  c=mix(c,vec3(.45,.4,.7),isl);
  return c; }
vec3 space(vec2 uv,float t){
  vec3 c=vec3(.02,.02,.08); float n=fbm(uv*3.+vec2(t*.01,0.)); c+=vec3(.35,.15,.55)*pow(n,2.5)*1.2+vec3(.1,.25,.55)*pow(fbm(uv*2.-3.),3.);
  c+=stars(uv,60.,t)+stars(uv+.3,25.,t*.7)*.8;
  vec2 pp=(uv-vec2(.3,.55))*vec2(uAspect.x,1.); float pr=length(pp); float planet=smoothstep(.2,.19,pr);
  vec3 pc=mix(vec3(.85,.6,.45),vec3(.95,.85,.7),sin(pp.y*40.+fbm(pp*6.)*4.)*.5+.5)*(.35+.65*clamp(dot(normalize(vec3(pp,sqrt(max(0.,.04-pr*pr)))),normalize(vec3(-.5,.4,.7))),0.,1.));
  c=mix(c,pc,planet); float ring=smoothstep(.012,.0,abs(length(pp*vec2(1.,3.2))-.32))*(1.-planet*step(0.,pp.y)); c+=ring*vec3(.9,.8,.7)*.8;
  vec2 ep=uv-vec2(.85,.05); float earth=smoothstep(.35,.34,length(ep*vec2(uAspect.x*.6,1.)+vec2(0.,-.1)));
  c=mix(c,mix(vec3(.15,.35,.85),vec3(.4,.7,1.),fbm(uv*8.)),earth*.9);
  return c; }
vec3 sky(vec2 uv,float t,int kind){
  vec3 top=kind==4?vec3(.35,.6,.98):kind==5?vec3(.35,.3,.7):vec3(.03,.05,.16);
  vec3 bot=kind==4?vec3(.8,.92,1.):kind==5?vec3(1.,.65,.45):vec3(.12,.15,.35);
  vec3 c=mix(bot,top,uv.y);
  if(kind==5) c+=vec3(1.,.8,.5)*exp(-ellipse(uv,vec2(.5,.25),vec2(.12))*1.2);
  if(kind==6){ c+=stars(uv,50.,t); c=mix(c,vec3(1.,.97,.85),smoothstep(.06,.05,length((uv-vec2(.7,.75))*vec2(uAspect.x,1.)))); }
  float cl=fbm(vec2(uv.x*2.5+t*.01,uv.y*5.)); c=mix(c,kind==6?vec3(.25,.28,.45):vec3(1.),smoothstep(.55,.8,cl)*.7);
  float hills=step(uv.y,.12+fbm(vec2(uv.x*4.,0.))*.08); c=mix(c,kind==4?vec3(.45,.7,.5):kind==5?vec3(.45,.3,.45):vec3(.08,.1,.2),hills);
  return c; }
/* The sky of the actual hour: night through dawn and day to dusk, the sun on its arc, cloud thickening with the rain. */
vec3 liveSky(vec2 uv,float t){
  float day=uSun, dusk=smoothstep(.75,.0,day)*step(.001,day);
  vec3 top=mix(vec3(.025,.04,.13),vec3(.24,.5,.92),day), bot=mix(vec3(.08,.11,.26),vec3(.76,.88,1.),day);
  bot=mix(bot,vec3(1.,.58,.36),dusk*.85); top=mix(top,vec3(.32,.26,.6),dusk*.5);
  vec3 c=mix(bot,top,pow(uv.y,.8));
  vec2 sp=vec2(uArc,.18+sin(clamp(uArc,0.,1.)*3.14159)*.7);
  float sd=length((uv-sp)*vec2(uAspect.x,1.));
  c+=vec3(1.,.82,.6)*(smoothstep(.07,.05,sd)*1.4+exp(-sd*4.2)*.55)*step(.001,day)*(1.-uRain*.92);
  if(day<.15) { c+=stars(uv,50.,t)*(1.-day/.15)*(1.-uRain); c=mix(c,vec3(1.,.97,.85),smoothstep(.05,.042,length((uv-vec2(.72,.74))*vec2(uAspect.x,1.)))*(1.-day/.15)*(1.-uRain)); }
  float cl=fbm(vec2(uv.x*2.6+t*.012,uv.y*5.2)); c=mix(c,mix(vec3(1.),vec3(.2,.21,.25),max(1.-day,uRain*.8)),smoothstep(.56-uRain*.42,.82-uRain*.3,cl)*(.7+uRain*.3));
  float hills=step(uv.y,.13+fbm(vec2(uv.x*4.,0.))*.09); c=mix(c,mix(vec3(.07,.09,.17),vec3(.4,.62,.44),day)*(1.-uRain*.35),hills);
  float win=step(.86,h21(floor(vec2(uv.x*64.,uv.y*38.))))*hills*(1.-smoothstep(0.,.3,day)); c+=win*vec3(1.,.8,.45)*.6;
  return c; }
/* Rain on this side of the glass: drops that hang and run, streaks beyond it. */
vec3 rainOn(vec3 c,vec2 uv,float t){
  c*=1.-uRain*.42; c=mix(c,vec3(dot(c,vec3(.33)))*vec3(.92,.97,1.05),uRain*.55);
  vec2 ruv=uv*vec2(70.,1.); float col=floor(ruv.x); float y=fract(uv.y*2.6+t*(1.5+h21(vec2(col,3.))*1.4)+h21(vec2(col,1.)));
  c+=smoothstep(0.,.03,y)*smoothstep(.16,.03,y)*step(1.-uRain*.55,h21(vec2(col,7.)))*.16*uRain*vec3(.8,.88,1.);
  for(int i=0;i<3;i++){ float s=8.+float(i)*7.; vec2 g=floor(uv*vec2(s*uAspect.x,s*.8)); float d=h21(g+float(i)*7.); vec2 f=fract(uv*vec2(s*uAspect.x,s*.8))-.5; float run=fract(t*(.03+d*.09)+d);
    float drop=smoothstep(.2,.08,length((f-vec2((d-.5)*.5,.42-run*.84))*vec2(1.,1.5)))*step(1.-uRain*.55,d); c+=drop*.2; }
  return c; }
void main(){
  vec2 uv=vUv; float t=uTime; vec3 c;
  if(uView==0) c=ocean(uv,t); else if(uView==1) c=rain(uv,t); else if(uView==2) c=magic(uv,t); else if(uView==3) c=space(uv,t); else if(uView==7) c=liveSky(uv,t); else c=sky(uv,t,uView);
  if(uRain>.005&&uView!=1) c=rainOn(c,uv,t);
  float vig=smoothstep(1.2,.3,length(uv-.5)); c*=.75+.25*vig;
  gl_FragColor=vec4(c,1.);
  #include <colorspace_fragment>
}`;

const vert = /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;

export function windowMaterial(view: WindowView, aspect: number): T.ShaderMaterial {
  return new T.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uView: { value: Math.max(0, VIEWS.indexOf(view)) }, uAspect: { value: new T.Vector2(aspect, 1) }, uRain: { value: 0 }, uSun: { value: .8 }, uArc: { value: .5 } },
    vertexShader: vert,
    fragmentShader: frag,
    toneMapped: false,
  });
}

/** How much light the view throws into the room (colour, strength). */
export function viewLight(view: WindowView): [string, number] {
  switch (view) {
    case 'ocean': return ['#7fb0ff', 1.6];
    case 'rain': return ['#6f7fd0', 0.7];
    case 'magic': return ['#e8b8e8', 1.2];
    case 'space': return ['#8fa0ff', 0.9];
    case 'day': return ['#fff4e0', 2.2];
    case 'sunset': return ['#ffb88a', 1.6];
    case 'live': return ['#fff4e0', 2];
    default: return ['#8090d0', 0.6];
  }
}
