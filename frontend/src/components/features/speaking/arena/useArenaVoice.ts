'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Room, RoomEvent, Track, ConnectionState, type RemoteAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { isAxiosError } from 'axios';
import { spatialGain } from './arenaSpatial';
import { ARENA_WATER_Y, arenaHeight } from './arenaTerrain';
import { getArenaVoice } from '@/services/speakingArenaApi';
import { authEnding, authEpoch, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import type { ArenaAudioSpace, ArenaState } from '@/types/speakingArena';

import type { ArenaMotion } from './arenaMotion';

/** When supported, include sound from other applications on the same output in the echo reference. */
async function configureEcho(track?: MediaStreamTrack) {
  if (!track?.getCapabilities || track.readyState!=='live') return;
  const modes=track.getCapabilities().echoCancellation as unknown[] | undefined;
  if(!modes?.includes('all') || String(track.getSettings().echoCancellation)==='all')return;
  // DOM typings in older TypeScript releases describe the original boolean constraint only.
  const constraints={...track.getConstraints(),echoCancellation:{exact:'all'}};
  try { await track.applyConstraints(constraints as unknown as MediaTrackConstraints); } catch { /* retain negotiated browser AEC */ }
}

export type VoiceStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'failed';
type VoiceDiagnostics = { context: string; localTracks: number; remoteTracks: number; sent: number; received: number; energy: number; jitterMs: number; rttMs: number; playback: boolean; spatial: { distance: number; gain: number; x: number; z: number }[] };
/** Browser-owned media and audio graph. No PCM, transcript, recording or voice payload reaches our API. */
export function useArenaVoice(state: ArenaState | null, controlConnected: boolean, space: RefObject<ArenaAudioSpace>, diagnosticsEnabled = false, motion?: ArenaMotion) {
  const [playable,setPlayable]=useState(false), [volume,setVolume]=useState(1);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [input,setInput]=useState('default'), [output,setOutput]=useState('default');
  const selectedInput=useRef(input), level=useRef(volume), statsEnabled=useRef(diagnosticsEnabled);
  level.current=volume; statsEnabled.current=diagnosticsEnabled; selectedInput.current=input;
  const refreshDevices=useCallback(async()=>{
    if(typeof navigator==='undefined'||!navigator.mediaDevices?.enumerateDevices)return;
    try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { /* unavailable before permission */ }
  },[]);
  const [wanted, setWanted] = useState(false), [mic, setMic] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>('off'), [error, setError] = useState('');
  const [published,setPublished]=useState(false);
  const [remoteMics,setRemoteMics]=useState<Record<string,boolean>>({});
  const [speakers, setSpeakers] = useState<string[]>([]), [quality, setQuality] = useState('unknown');
  const [attempt, setAttempt] = useState(0), [muted, setMuted] = useState<Set<string>>(new Set());
  const [remoteDuck, setRemoteDuck] = useState(false);
  const [diagnostics, setDiagnostics] = useState<VoiceDiagnostics | null>(null);
  const roomRef = useRef<Room | null>(null), context = useRef<AudioContext | null>(null);
  const syncMicRef = useRef<(() => Promise<void>) | null>(null), startVersion = useRef(0);
  const stateRef = useRef(state), micRef = useRef(mic), mutedRef = useRef(muted), remoteDuckRef = useRef(remoteDuck);
  stateRef.current = state; micRef.current = mic; mutedRef.current = muted; remoteDuckRef.current = remoteDuck;
  const me = state?.players.find(p => p.id === state.self);
  const identity = me?.voiceIdentity, roomId = state?.roomId, maySpeak = !!me?.canSpeak;
  const start = useCallback(async (withMic=false) => {
    const version = ++startVersion.current;
    setError('');
    try {
      if (!context.current || context.current.state === 'closed') context.current = new AudioContext({ latencyHint: 'interactive' });
      await context.current.resume();
      if (version !== startVersion.current) return;
      if(withMic){micRef.current=true;setMic(true);}
      setWanted(true); setAttempt(a => a + 1);
    } catch { setError('AUDIO_BLOCKED'); setStatus('blocked'); }
  }, []);
  const stop = useCallback(() => { startVersion.current++; micRef.current = false; setWanted(false); setMic(false); void roomRef.current?.disconnect(true); }, []);
  useEffect(() => {
    if (!wanted || !roomId || !identity || !controlConnected) { setStatus('off'); return; }
    const ctx = context.current;
    if (!ctx || ctx.state === 'closed') return;
    let disposed = false;
    const epoch = authEpoch(), abort = new AbortController();
    const streams = new Map<string, { track: RemoteAudioTrack; panner: PannerNode; gain: GainNode; element: HTMLMediaElement; target: number }>();
    const room = new Room({ webAudioMix: { audioContext: ctx }, adaptiveStream: false, dynacast: false,
      audioCaptureDefaults: { ...(selectedInput.current==='default'?{}:{deviceId:selectedInput.current}), echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      publishDefaults: { audioPreset: { maxBitrate: 48000 }, dtx: true, red: true, stopMicTrackOnMute: true },
    });
    roomRef.current = room; setStatus('connecting'); setError('');
    // Serialize capture changes. Permission can resolve after leave, control loss or host mute.
    let micWork: Promise<void> | null = null, micRequested = false;
    const allowed = () => !disposed && !authEnding() && epoch === authEpoch() && micRef.current &&
      !!stateRef.current?.players.find(p => p.id === stateRef.current?.self)?.canSpeak;
    const syncMic = (): Promise<void> => {
      micRequested = true;
      if (micWork) return micWork;
      micWork = (async () => {
        while (micRequested && !disposed) {
          micRequested = false;
          const enabled = allowed();
          try {
            const pub=await room.localParticipant.setMicrophoneEnabled(enabled);
            if(enabled && allowed()){
              await configureEcho(pub?.track?.mediaStreamTrack);
              void refreshDevices();
            }
            if(!disposed)setPublished(!!pub?.track && !pub.isMuted && pub.track.mediaStreamTrack.readyState==='live');
            if (enabled && !allowed()) await room.localParticipant.setMicrophoneEnabled(false);
          } catch {
            if (!disposed) { micRef.current = false; setMic(false); setPublished(false); setError('MIC_DENIED'); }
          } finally { if (disposed) await room.disconnect(true); }
        }
      })().finally(() => { micWork = null; });
      return micWork;
    };
    syncMicRef.current = syncMic;
    const detach = (id: string) => {
      const value = streams.get(id); if (!value) return;
      value.track.detach().forEach(el => el.remove()); value.track.setWebAudioPlugins([]);
      value.panner.disconnect(); value.gain.disconnect(); streams.delete(id);
    };
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio || participant.identity === identity || disposed) return;
      detach(participant.identity);
      const audio = track as RemoteAudioTrack;
      const panner = ctx.createPanner(), gain = ctx.createGain();
      panner.panningModel = 'equalpower'; panner.distanceModel = 'inverse';
      panner.rolloffFactor = 0; // Direction comes from the panner, level from spatialGain alone.
      gain.gain.value = 0; // silence unknown/unbound identities until the authoritative roster arrives
      audio.setWebAudioPlugins([panner, gain]);
      const element = audio.attach(); element.hidden = true; document.body.append(element);
      streams.set(participant.identity, { track: audio, panner, gain, element, target: 0 });
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => { if(streams.get(participant.identity)?.track===track)detach(participant.identity); });
    room.on(RoomEvent.ParticipantDisconnected, participant => detach(participant.identity));
    const refreshMics=()=>{if(!disposed)setRemoteMics(Object.fromEntries([...room.remoteParticipants.values()].map(p=>[p.identity,p.isMicrophoneEnabled])));};
    room.on(RoomEvent.Connected,refreshMics).on(RoomEvent.Reconnected,refreshMics).on(RoomEvent.ParticipantConnected,refreshMics)
      .on(RoomEvent.ParticipantDisconnected,refreshMics).on(RoomEvent.TrackMuted,refreshMics).on(RoomEvent.TrackUnmuted,refreshMics)
      .on(RoomEvent.TrackPublished,refreshMics).on(RoomEvent.TrackUnpublished,refreshMics);
    room.on(RoomEvent.ActiveSpeakersChanged, list => { if (!disposed) setSpeakers(list.map(p => p.identity)); });
    room.on(RoomEvent.ConnectionQualityChanged, (q, participant) => { if (!disposed && participant.isLocal) setQuality(q); });
    const syncPlayback=()=>{
      if(disposed)return;
      const playing=room.canPlaybackAudio && ctx.state==='running';
      setPlayable(playing);
      if(playing)setError(old=>old==='AUDIO_BLOCKED'?'':old);
    };
    ctx.addEventListener('statechange',syncPlayback);
    room.on(RoomEvent.AudioPlaybackStatusChanged,syncPlayback);
    room.on(RoomEvent.ConnectionStateChanged, s => {
      if (disposed) return;
      if (s === ConnectionState.Connected) setStatus('connected');
      else if (s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting) setStatus('reconnecting');
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!disposed) {
        setStatus('failed');
        setError('VOICE_DISCONNECTED');
        setPublished(false);
        setSpeakers([]);
        setRemoteMics({});
      }
    });
    const param = (p: AudioParam, value: number) => p.setTargetAtTime(value, ctx.currentTime, .055);
    const resolveElevation = (
      pose: { x: number; z: number; y?: number; diveDepth?: number } | undefined,
      member?: { diveDepth?: number },
    ): number => {
      if (!pose) return 0;
      if (typeof pose.y === 'number' && Number.isFinite(pose.y)) return pose.y;
      const groundY = arenaHeight(pose.x, pose.z);
      if (groundY >= ARENA_WATER_Y) return groundY;
      const dive = typeof pose.diveDepth === 'number' ? pose.diveDepth : typeof member?.diveDepth === 'number' ? member.diveDepth : 0;
      return Math.max(groundY, ARENA_WATER_Y - Math.max(0, dive));
    };
    const spatial = () => {
      if (disposed) return;
      const current = stateRef.current, self = current?.players.find(p => p.id === current.self);
      // Voice works without WebGL and while rendering is paused. The server remains the fallback position authority.
      const fresh = space.current.updatedAt != null && performance.now() - space.current.updatedAt < 500;
      const latest=(member:typeof self)=>member && (motion?.history.get(member.id)?.at(-1) ?? member);
      const listener = fresh ? space.current.listener : latest(self) ?? { x: 0, z: 0, yaw: Math.PI };
      const listenerY = resolveElevation(listener, self);
      const listenerBoat = listener.boat ?? self?.boat ?? null;
      const audioListener = ctx.listener;
      if (audioListener.positionX) {
        param(audioListener.positionX, listener.x); param(audioListener.positionY, listenerY + 1.6); param(audioListener.positionZ, listener.z);
        param(audioListener.forwardX, Math.sin(listener.yaw)); param(audioListener.forwardY, 0); param(audioListener.forwardZ, Math.cos(listener.yaw));
        param(audioListener.upX, 0); param(audioListener.upY, 1); param(audioListener.upZ, 0);
      } else {
        audioListener.setPosition(listener.x, listenerY + 1.6, listener.z);
        audioListener.setOrientation(Math.sin(listener.yaw), 0, Math.cos(listener.yaw), 0, 1, 0);
      }
      for (const [id, value] of streams) {
        const member = current?.players.find(m => m.voiceIdentity === id);
        const p = fresh ? space.current.players.get(id) ?? latest(member) : latest(member);
        const peerY = resolveElevation(p, member);
        const peerBoat = p?.boat ?? member?.boat ?? null;
        const distance = p ? Math.hypot(p.x - listener.x, p.z - listener.z, peerY - listenerY) : 100;
        const sameBoat = Boolean(listenerBoat && peerBoat && listenerBoat === peerBoat);
        const activeStructuredSpeaker = Boolean(current?.phase === 'TALK' && current.speaker && member?.id === current.speaker);
        const baseGain = sameBoat || activeStructuredSpeaker ? 1 : spatialGain(distance);
        const target =
          p && member?.canSpeak && member.online && !mutedRef.current.has(member.id) && !remoteDuckRef.current
            ? baseGain * level.current
            : 0;
        if(target!==value.target){
          const gain=value.gain.gain, t=ctx.currentTime;
          gain.cancelScheduledValues(t);gain.setValueAtTime(gain.value,t);
          gain.linearRampToValueAtTime(target,t+.045);
          value.target=target;
        }
        if (p) { param(value.panner.positionX, p.x); param(value.panner.positionY, peerY + 1.6); param(value.panner.positionZ, p.z); }
      }
    };
    const spatialTimer = setInterval(spatial, 50);
    // Opt-in local qualification only. Counters contain no audio, tokens, identities or endpoint addresses.
    let readingStats = false;
    const statsTimer = setInterval(() => {
      if (!statsEnabled.current || disposed || readingStats) return;
      readingStats = true;
      void (async () => {
        const value: VoiceDiagnostics = { context: ctx.state, localTracks: 0, remoteTracks: streams.size, sent: 0, received: 0, energy: 0, jitterMs: 0, rttMs: 0, playback: room.canPlaybackAudio, spatial: [] };
        for (const publication of room.localParticipant.audioTrackPublications.values()) {
          const track = publication.track;
          if (!track) continue;
          if (track.mediaStreamTrack.readyState === 'live' && !track.isMuted) value.localTracks++;
          const stats = await (track as LocalAudioTrack).getSenderStats();
          value.sent += stats?.bytesSent ?? 0; value.rttMs = Math.max(value.rttMs, (stats?.roundTripTime ?? 0) * 1000);
        }
        for (const stream of streams.values()) {
          const stats = await stream.track.getReceiverStats();
          value.received += stats?.bytesReceived ?? 0; value.energy += stats?.totalAudioEnergy ?? 0;
          value.jitterMs = Math.max(value.jitterMs, (stats?.jitter ?? 0) * 1000);
          const dx = stream.panner.positionX.value - ctx.listener.positionX.value, dz = stream.panner.positionZ.value - ctx.listener.positionZ.value;
          const distance = Math.hypot(dx, dz);
          value.spatial.push({ distance, gain: stream.gain.gain.value, x: dx, z: dz });
        }
        if (!disposed) setDiagnostics(value);
      })().catch(() => { /* Stats are best-effort and never affect voice. */ }).finally(() => { readingStats = false; });
    }, 2000);
    void (async () => {
      try {
        // A host transition revokes old identities before it grants the new speaking policy.
        // Only retry its transient lock. An identity change aborts this effect and starts a fresh grant.
        const requestGrant=async()=>{
          for(let n=0;;n++){
            try{return await getArenaVoice(roomId,abort.signal);}
            catch(e){
              if(disposed||!isAxiosError(e)||e.response?.status!==409||e.response.data?.message!=='ROOM_BUSY'||n>=5)throw e;
              await new Promise(resolve=>setTimeout(resolve,250*(n+1)));
              if(disposed||abort.signal.aborted)throw e;
            }
          }
        };
        const ticket = await requestGrant();
        if (disposed || authEnding() || epoch !== authEpoch()) return;
        if (ticket.identity !== identity) throw new Error('Identity changed');
        await room.connect(ticket.url, ticket.token, { autoSubscribe: true });
        if (disposed) { await room.disconnect(true); return; }
        try { await room.startAudio(); syncPlayback(); void refreshDevices(); }
        catch { if(!disposed)setError('AUDIO_BLOCKED'); }
        if (disposed) { await room.disconnect(true); return; }
        if (micRef.current) await syncMic();
      } catch (e) {
        if (disposed) return;
        const name = e instanceof Error ? e.name : '';
        const code = isAxiosError(e) ? e.response?.data?.code ?? e.response?.data?.message : undefined;
        setStatus('failed'); setError(name === 'NotAllowedError' ? 'MIC_DENIED' : typeof code === 'string' ? code : 'VOICE_UNAVAILABLE');
        void room.disconnect(true);
      }
    })();
    const cancel = subscribeAuthLifecycle(() => { if (authEnding() || epoch !== authEpoch()) { stop(); } });
    return () => {
      disposed = true; ctx.removeEventListener('statechange',syncPlayback);setPlayable(false); abort.abort(); cancel(); clearInterval(spatialTimer); if (statsTimer) clearInterval(statsTimer); setDiagnostics(null);
      for (const id of [...streams.keys()]) detach(id);
      room.removeAllListeners(); void room.disconnect(true);
      if (syncMicRef.current === syncMic) syncMicRef.current = null;
      if (roomRef.current === room) roomRef.current = null;
      setSpeakers([]);setRemoteMics({});setPublished(false);
    };
  }, [wanted, roomId, identity, controlConnected, attempt, space, stop, motion, refreshDevices]);
  useEffect(() => {
    const room = roomRef.current;
    if (room?.state === ConnectionState.Connected) {
      void syncMicRef.current?.();
    }
  }, [mic, maySpeak]);
  useEffect(() => {
    if (!state) { setWanted(false); setMic(false); setMuted(new Set()); }
  }, [state?.roomId]); // reset only when membership ends, not on movement snapshots
  useEffect(() => () => { startVersion.current++; micRef.current = false; void context.current?.close(); context.current = null; }, []);
  const toggleMute = useCallback((id: string) => setMuted(previous => { const next = new Set(previous); if(next.has(id))next.delete(id);else next.add(id);return next; }), []);
  const selectDevice=async(kind:'audioinput'|'audiooutput',id:string)=>{
    const room=roomRef.current;
    if(!room)return;
    try{
      if(kind==='audioinput'){
        if(!await room.switchActiveDevice(kind,id))throw new Error('device');
        await configureEcho(room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack);
        setInput(id);
      }else{
        const ctx=context.current as (AudioContext & {setSinkId?:(id:string)=>Promise<void>})|null;
        if(!ctx?.setSinkId)throw new Error('device');
        await ctx.setSinkId(id==='default'?'':id);setOutput(id);
      }
    }catch{setError('DEVICE_UNAVAILABLE');}
  };
  const setMicEnabled = useCallback((enabled: boolean) => { micRef.current = enabled; setMic(enabled); }, []);
  return { status, error, playable,volume,setVolume,input,output,devices,selectDevice,refreshDevices, published, speakers, remoteMics, quality, mic, setMicEnabled, remoteDuck, setRemoteDuck, muted, diagnostics, start, stop, toggleMic: () => setMic(v => !v), toggleMute,
    dismissError: () => setError(''),
    resumeAudio: async () => { try { await Promise.all([context.current?.resume(),roomRef.current?.startAudio()]); const ok=context.current?.state==='running'&&!!roomRef.current?.canPlaybackAudio;setPlayable(ok);setError(ok?'':'AUDIO_BLOCKED'); } catch { setError('AUDIO_BLOCKED'); } } };
}
