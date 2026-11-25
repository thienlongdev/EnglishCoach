(() => {
  if (window.__echoMediaBridge || Array.from(location.ancestorOrigins).some((o) => o !== location.origin))
    return;
  window.__echoMediaBridge = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'echo-media' || port.sender?.id !== chrome.runtime.id) return;
    let media,
      trackCleanup = () => {},
      epoch = 0,
      lastTime = 0,
      segment = null,
      stopped = false,
      asr,
      asrTimer,
      stream,
      asrTrack,
      oldRate,
      chosenRate;
    const adapters=window.__echoAdapters;
    let dockOff, overlay, boundId=adapters.identity(), invalid=false;
    function switched(){
      if(invalid || stopped)return;
      invalid=true;
      post({type:'switch',reconnect:!!boundId && !!adapters.identity()});close();
    }
    const life = new AbortController();
    const signal = life.signal;
    const post = (m) => {
      if (!stopped)
        try {
          port.postMessage(m);
        } catch {}
    };
    const error = (message) => post({ type: 'error', message });
    const stopRecognition = () => {
      clearTimeout(asrTimer);
      if (asr) {
        asr.onresult = null;
        asr.abort();
        asr = null;
      }
      asrTrack?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      asrTrack = null;
    };
    const close = () => {
      if (stopped) return;
      stopped = true;
      life.abort();
      dockOff?.();overlay?.close();
      trackCleanup();
      stopRecognition();
      segment = null;
      if (media && chosenRate != null && media.playbackRate === chosenRate) media.playbackRate = oldRate;
      try {
        port.disconnect();
      } catch {}
    };
    port.onDisconnect.addListener(close);
    window.addEventListener('pagehide', close, { once: true, signal });
    window.navigation?.addEventListener('navigatesuccess',()=>{if(!boundId || adapters.identity()!==boundId)switched();},{signal});
    document.addEventListener('yt-navigate-finish',()=>{if(boundId && (adapters.identity()!==boundId || (media && media!==adapters.choose())))switched();},{signal});
    function tick(force = false) {
      if (!media || stopped) return;
      if(boundId && adapters.identity()!==boundId){switched();return;}
      if (segment && media.currentTime >= segment.end - 0.025) {
        if (segment.loop) {
          media.currentTime = segment.start;
        } else {
          media.pause();
          segment = null;
        }
      }
      if (document.hidden && !force) return;
      const now = performance.now();
      if (force || now - lastTime > 150) {
        lastTime = now;
        post({ type: 'time', time: media.currentTime, rate: media.playbackRate, paused: media.paused });
      }
    }
    function attachTracks() {
      trackCleanup();
      const restore = [],
        listeners = [],
        tracks = Array.from(media.textTracks).filter((t) => ['subtitles', 'captions'].includes(t.kind));
      const track = (lang) => tracks.find((t) => new RegExp('^' + lang + '(?:-|$)', 'i').test(t.language));
      const en = track('en'),
        vi = track('vi');
      const read = (t) => {
        try {
          return Array.from(t?.cues || [])
            .slice(0, 2500)
            .map((c) => ({
              start: c.startTime,
              end: c.endTime,
              text: (c.text || '').replace(/<[^>]*>/g, '').slice(0, 1400),
            }))
            .filter((c) => c.text);
        } catch {
          return [];
        }
      };
      let native=false;
      const snapshot = () => {const english=read(en); native=english.length>0;post({type:'tracks',en:english,vi:read(vi),youtube:!!boundId,chapters:adapters.chapters(media)});};
      for (const t of [en, vi].filter(Boolean)) {
        if (t.mode === 'disabled') {
          t.mode = 'hidden';
          restore.push(t);
        }
        const cueChanged = () => {
          if (!document.hidden) {
            tick(true);
            const c = t.activeCues?.[0];
            if (c)
              post({
                type: 'cue',
                lang: t === en ? 'en' : 'vi',
                start: c.startTime,
                end: c.endTime,
                text: String(c.text || '')
                  .replace(/<[^>]*>/g, '')
                  .slice(0, 1400),
              });
          }
        };
        t.addEventListener('cuechange', cueChanged);
        listeners.push(() => t.removeEventListener('cuechange', cueChanged));
      }
      for (const el of media.querySelectorAll('track')) {
        el.addEventListener('load', snapshot);
        listeners.push(() => el.removeEventListener('load', snapshot));
      }
      const offDom=adapters.displayed(media,c=>{if(!native && boundId===adapters.identity())post({type:'visible',...c});});
      trackCleanup = () => {
        offDom();listeners.forEach((fn) => fn());
        restore.forEach((t) => {
          if (t.mode === 'hidden') t.mode = 'disabled';
        });
      };
      snapshot();
      tick(true);
    }
    async function recognize() {
      stopRecognition();
      const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
      if (
        !media ||
        !Rec?.available ||
        media.mediaKeys ||
        !media.currentSrc.startsWith(location.origin + '/') ||
        !media.captureStream
      )
        throw Error('Nguồn này chưa hỗ trợ nhận dạng âm thanh cục bộ. Hãy dùng SRT/VTT.');
      if ((await Rec.available({ langs: ['en-US'], processLocally: true })) !== 'available' || stopped)
        throw Error('Chưa có gói nhận dạng tiếng Anh trên thiết bị.');
      // Enforce a hard microphone boundary even if a vendor silently ignores start(track).
      if ((await navigator.permissions.query({ name: 'microphone' })).state !== 'denied')
        throw Error(
          'Nhận dạng âm thanh trình phát cần quyền mic của website ở trạng thái chặn. Bạn có thể dùng SRT/VTT.',
        );
      asr = new Rec();
      if (!('processLocally' in asr)) throw Error('Trình duyệt chưa có nhận dạng cục bộ.');
      // Pass an audio track only on implementations supporting the audioTrack overload.
      // A browser that ignores that overload might open the microphone. Keep it disabled there.
      if (
        !('MediaStreamTrackProcessor' in globalThis) ||
        !/Chrome\/(\d+)/.test(navigator.userAgent) ||
        +RegExp.$1 < 135
      )
        throw Error('Hãy dùng phụ đề của bạn trong trình duyệt này.');
      stream = media.captureStream();
      asrTrack = stream.getAudioTracks()[0];
      if (!asrTrack) throw Error('Trình phát chưa cung cấp đoạn âm thanh.');
      asr.processLocally = true;
      asr.lang = 'en-US';
      asr.continuous = true;
      let start = media.currentTime;
      asr.onresult = (e) => {
        const line = e.results[e.resultIndex];
        if (line.isFinal) {
          const end = media.currentTime;
          post({ type: 'asr', start, end, text: line[0].transcript });
          start = end;
        }
      };
      asr.onerror = () => {
        error('Không nhận dạng được đoạn âm thanh cục bộ.');
        stopRecognition();
      };
      asr.onend = () => {
        post({ type: 'asr-end' });
        clearTimeout(asrTimer);
        stream?.getTracks().forEach((t) => t.stop());
      };
      asr.start(asrTrack);
      post({ type: 'asr-start' });
      asrTimer = setTimeout(stopRecognition, 30000);
    }
    port.onMessage.addListener(async (m) => {
      try {
        if (m.type === 'attach') {
          media = adapters.choose();
          if (!media) {
            error('Không tìm thấy trình phát. Hãy dán văn bản hoặc nhập SRT/VTT.');
            return;
          }
          const scope = await window.__echoMediaScope(media);
          if (stopped) return;
          if (
            scope?.kind === 'private' ||
            /(^|\.)(spotify\.com|soundcloud\.com)$/.test(location.hostname) ||
            media.mediaKeys
          ) {
            post({
              type: 'manual',
              scope,
              message: 'Dùng trích đoạn bạn có quyền sử dụng. Trang này chỉ hỗ trợ học thủ công.',
            });
            media = null;
            return;
          }
          post({ type: 'attached', scope });
          dockOff=window.__echoMediaDock?.(media);
          overlay=window.__echoOverlay(media,(word,text)=>post({type:'pick',word,text}));
          const parent = media.parentElement;
          if (parent) {
            const observer = new MutationObserver(() => {
              if (!media.isConnected) {
                switched();
              }
            });
            observer.observe(parent, { childList: true });
            signal.addEventListener('abort', () => observer.disconnect(), { once: true });
          }
          media.addEventListener(
            'encrypted',
            () => {
              error('Trình phát dùng nội dung bảo vệ. Hãy tự cung cấp trích đoạn.');
              close();
            },
            { once: true, signal },
          );
          const refresh = async () => {
            segment = null;
            stopRecognition();
            const next = ++epoch;
            post({ type: 'reset', epoch: next });
            const context = await window.__echoMediaScope(media);
            if (stopped || next !== epoch) return;
            if (context?.kind === 'private' || context?.id !== scope?.id || media.mediaKeys) {
              close();
              return;
            }
            attachTracks();
          };
          media.addEventListener('loadedmetadata', refresh, { signal });
          media.addEventListener(
            'emptied',
            () => {
              segment = null;
              stopRecognition();
              trackCleanup();
              post({ type: 'reset', epoch: ++epoch });
            },
            { signal },
          );
          media.textTracks.addEventListener('addtrack', attachTracks, { signal });
          media.textTracks.addEventListener('removetrack', attachTracks, { signal });
          for (const name of ['timeupdate', 'play', 'pause', 'seeked', 'ratechange'])
            media.addEventListener(name, () => tick(name !== 'timeupdate'), { signal });
          document.addEventListener(
            'visibilitychange',
            () => {
              if (!document.hidden) tick(true);
            },
            { signal },
          );
          attachTracks();
          return;
        }
        if (!media || !media.isConnected) {
          error('Trình phát đã thay đổi. Hãy kết nối lại.');
          return;
        }
        if(m.type==='overlay'){overlay?.show(m);return;}
        if(m.type==='transcript'){const lines=adapters.transcript(media);post({type:'transcript',lines,chapters:adapters.chapters(media)});return;}
        if(m.type==='seek' && Number.isFinite(m.start) && m.start>=0){segment=null;media.currentTime=m.start;tick(true);return;}
        if (m.type === 'rate' && [0.5, 0.75, 1, 1.25, 1.5].includes(m.rate)) {
          if (chosenRate == null) oldRate = media.playbackRate;
          media.playbackRate = m.rate;
          chosenRate = m.rate;
        }
        if (m.type === 'clear') segment = null;
        if (
          m.type === 'segment' &&
          Number.isFinite(m.start) &&
          Number.isFinite(m.end) &&
          m.start >= 0 &&
          m.end > m.start
        ) {
          segment = m.loop || m.pause ? { start: m.start, end: m.end, loop: !!m.loop } : null;
          if (m.seek) {
            media.currentTime = m.start;
            await media.play();
          }
        }
        if (m.type === 'recognize') await recognize();
        if (m.type === 'stop-asr') {
          stopRecognition();
          post({ type: 'asr-end' });
        }
      } catch (e) {
        stopRecognition();
        error(String(e.message || 'Trình phát chưa hỗ trợ thao tác này.'));
      }
    });
  });
})();
