/** King-owned small synth; the existing Card Blast synth is game-specific, not a shared audio service.
 * Opt-in through a user gesture, no preload/assets/listeners, <=4 live voices, explicit disposal.
 * Every cue is ONE oscillator whose pitch steps through a short phrase (an arpeggio for a correct answer, a falling pair for a
 * miss, a fanfare for a crown): rich enough to feel like a game, light enough never to clip or pile up.
 */
type Cue = 'place'|'select'|'correct'|'wrong'|'win'|'lose'|'tick'|'capture';
const CUES:Record<Cue,{wave:OscillatorType;gain:number;notes:[number,number][];end:number}>={
  // [frequency Hz, start offset s]; `end` = the voice's length
  place:{wave:'triangle',gain:.05,notes:[[520,0],[660,.04]],end:.1},
  select:{wave:'triangle',gain:.04,notes:[[440,0],[560,.035]],end:.08},
  correct:{wave:'triangle',gain:.06,notes:[[659,0],[784,.07],[988,.14],[1319,.21]],end:.42},
  wrong:{wave:'sine',gain:.055,notes:[[330,0],[247,.12]],end:.34},
  win:{wave:'triangle',gain:.065,notes:[[523,0],[659,.12],[784,.24],[1047,.36],[784,.5],[1047,.6],[1319,.72]],end:1.1},
  lose:{wave:'sine',gain:.05,notes:[[392,0],[349,.18],[294,.36]],end:.7},
  tick:{wave:'square',gain:.018,notes:[[1200,0]],end:.04},
  capture:{wave:'triangle',gain:.06,notes:[[392,0],[523,.06],[659,.12],[880,.18]],end:.36},
};
export class KingAudio {
  private context: AudioContext|null=null;
  private enabled=false;
  private voices=new Set<OscillatorNode>();
  private cleanups=new Map<OscillatorNode,()=>void>();
  private last=-Infinity;
  get on(){return this.enabled;}
  enable(enabled:boolean){
    this.enabled=enabled;
    if(!enabled){this.clearVoices();return;}
    if(typeof window==='undefined')return;
    try{this.context??=new AudioContext();void this.context.resume().catch(()=>{});}catch{this.enabled=false;}
  }
  play(kind:Cue){
    const ctx=this.context;
    if(!this.enabled||!ctx||ctx.state!=='running'||this.voices.size>=4||ctx.currentTime-this.last<.08)return;
    this.last=ctx.currentTime;
    const cue=CUES[kind],t=ctx.currentTime,voice=ctx.createOscillator(),gain=ctx.createGain();
    voice.type=cue.wave;
    for(const [f,at] of cue.notes)voice.frequency.setValueAtTime(f,t+at);
    gain.gain.setValueAtTime(cue.gain,t);
    for(const [,at] of cue.notes.slice(1))gain.gain.setValueAtTime(cue.gain,t+at);
    gain.gain.exponentialRampToValueAtTime(.001,t+cue.end);
    voice.connect(gain);gain.connect(ctx.destination);this.voices.add(voice);
    const cleanup=()=>{voice.disconnect();gain.disconnect();this.voices.delete(voice);this.cleanups.delete(voice);voice.onended=null;};
    this.cleanups.set(voice,cleanup);voice.onended=cleanup;
    voice.start();voice.stop(t+cue.end);
  }
  private clearVoices(){
    for(const voice of [...this.voices]){try{voice.stop();}catch{}this.cleanups.get(voice)?.();}
  }
  close(){
    this.enabled=false;
    this.clearVoices();const ctx=this.context;this.context=null;if(ctx)void ctx.close().catch(()=>{});
  }
}
