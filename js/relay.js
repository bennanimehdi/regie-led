/* Régie LED — relais vidéo entre la régie et la fenêtre de sortie.
 *
 * Une fenêtre capturée (« Fenêtre en direct », PowerPoint) est choisie dans la régie. La fenêtre de sortie est une autre
 * fenêtre du navigateur : quand elle ne peut pas relire directement la capture de la régie, la régie la lui envoie par une
 * liaison WebRTC locale (rien ne sort de l'ordinateur). La mise en relation passe par un BroadcastChannel.
 *
 * Messages : sortie → {t:'want', id, peer}   « je veux la capture du clip id »
 *            régie  → {t:'offer', id, peer, sdp}      sortie → {t:'answer', id, peer, sdp}
 *            régie  → {t:'reset', id?}       « la capture a changé : redemande-la »
 */
const CH = 'regie-led-rtc';

/** Attend la fin de la collecte des adresses locales (immédiate sur une même machine), 1,5 s au plus. */
const gathered = pc => new Promise(resolve => {
  if (pc.iceGatheringState === 'complete') return resolve();
  const t = setTimeout(resolve, 1500);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
});
const close = pc => { try { pc?.close(); } catch { /* déjà fermée */ } };

/** Côté régie : envoie la capture d'un clip à toute fenêtre de sortie qui la demande. getStream(id) → MediaStream ou rien. */
export function startSender(getStream) {
  const bc = new BroadcastChannel(CH), pcs = new Map();          // « peer|id » → {pc, stream}
  const drop = key => { close(pcs.get(key)?.pc); pcs.delete(key); };
  bc.onmessage = async ev => {
    const m = ev.data;
    try {
      if (m.t === 'want') {
        const stream = getStream(m.id), key = m.peer + '|' + m.id;
        if (!stream || !stream.active) return;
        const old = pcs.get(key);
        if (old && old.stream === stream && ['new', 'connecting', 'connected'].includes(old.pc.connectionState)) return;
        drop(key);
        const pc = new RTCPeerConnection({ iceServers: [] });
        pcs.set(key, { pc, stream });
        const track = stream.getVideoTracks()[0];
        try { track.contentHint = 'detail'; } catch { /* indication facultative : privilégier la netteté (texte, diapositives) */ }
        pc.addTrack(track, stream);
        for (const a of stream.getAudioTracks()) pc.addTrack(a, stream);          // son de la capture, s'il y en a un
        pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState) && pcs.get(key)?.pc === pc) drop(key); });
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        bc.postMessage({ t: 'offer', id: m.id, peer: m.peer, sdp: pc.localDescription.toJSON() });
      } else if (m.t === 'answer') {
        const e = pcs.get(m.peer + '|' + m.id);
        if (!e) return;
        await e.pc.setRemoteDescription(m.sdp);
        const sender = e.pc.getSenders()[0], p = sender.getParameters();          // liaison locale : on peut viser haut
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 25e6; p.encodings[0].maxFramerate = 30; p.degradationPreference = 'maintain-resolution';
        sender.setParameters(p).catch(() => {});
      }
    } catch (e) { console.warn('relais vidéo (régie)', e); }
  };
  bc.postMessage({ t: 'reset' });                                 // la régie vient de (re)démarrer : les anciennes liaisons sont mortes
  return {
    /** La capture du clip a changé ou s'est arrêtée : on coupe, la sortie redemandera. */
    reset(id) { for (const k of [...pcs.keys()]) if (!id || k.endsWith('|' + id)) drop(k); bc.postMessage({ t: 'reset', id }); },
    states: () => [...pcs].map(([k, e]) => k + ':' + e.pc.connectionState),
  };
}

/** Côté sortie : demande à la régie la capture des clips voulus (wanted() → [ids]) qu'elle n'a pas déjà (has(id)).
 *  Les flux reçus sont rangés dans window.__ledRemote[id]. */
export function startReceiver(wanted, has) {
  const bc = new BroadcastChannel(CH), peer = Math.random().toString(36).slice(2, 9), pcs = new Map();   // id → {pc, asked}
  const remote = window.__ledRemote = {};
  const drop = id => { close(pcs.get(id)?.pc); pcs.delete(id); delete remote[id]; };
  bc.onmessage = async ev => {
    const m = ev.data;
    try {
      if (m.t === 'reset') { for (const id of [...pcs.keys()]) if (!m.id || m.id === id) drop(id); return; }
      if (m.t !== 'offer' || m.peer !== peer) return;
      drop(m.id);
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcs.set(m.id, { pc, asked: Date.now() });
      pc.addEventListener('track', e => {
        try { e.receiver.playoutDelayHint = 0; } catch { /* réglage facultatif : le moins de retard possible */ }
        remote[m.id] = e.streams[0] || new MediaStream([e.track]);
      });
      pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && pcs.get(m.id)?.pc === pc) drop(m.id); });
      await pc.setRemoteDescription(m.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      bc.postMessage({ t: 'answer', id: m.id, peer, sdp: pc.localDescription.toJSON() });
    } catch (e) { console.warn('relais vidéo (sortie)', e); }
  };
  setInterval(() => {
    const ids = wanted(), now = Date.now();
    for (const id of [...pcs.keys()]) if (!ids.includes(id)) drop(id);
    for (const id of ids) {
      if (has(id)) { if (pcs.has(id)) drop(id); continue; }       // la capture arrive déjà en direct : pas besoin de relais
      const e = pcs.get(id);
      if (e?.pc && e.pc.connectionState !== 'connected' && now - e.asked > 10000) drop(id);     // liaison qui n'aboutit pas : on recommence
      else if (e && (e.pc || now - e.asked < 4000)) continue;
      pcs.set(id, { pc: null, asked: now });
      bc.postMessage({ t: 'want', id, peer });
    }
  }, 1000);
  return { states: () => [...pcs].map(([k, e]) => k + ':' + (e.pc ? e.pc.connectionState : 'demande')) };
}
