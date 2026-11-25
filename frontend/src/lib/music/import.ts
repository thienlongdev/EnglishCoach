import { validateMusicFile } from './model';
import type { StoredTrack } from './model';

function text(bytes: Uint8Array): string {
  const encoding = bytes[0];
  return new TextDecoder(encoding === 1 ? 'utf-16' : encoding === 2 ? 'utf-16be' : encoding === 3 ? 'utf-8' : 'windows-1252')
    .decode(bytes.subarray(1)).replace(/\0/g, '').trim();
}
/** Bounded ID3 v2.3 / v2.4 reading; never decode the whole audio into memory. */
async function tags(file: File): Promise<{ title?: string; artist?: string; cover?: Blob }> {
  const bytes = new Uint8Array(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const result: { title?: string; artist?: string; cover?: Blob } = {};
  if (String.fromCharCode(...bytes.subarray(0, 3)) !== 'ID3' || ![3, 4].includes(bytes[3])) return result;
  const sync = (b: Uint8Array) => ((b[0] & 127) << 21) | ((b[1] & 127) << 14) | ((b[2] & 127) << 7) | (b[3] & 127);
  // Unsynchronised / extended tags fall back to the filename rather than guessing frame boundaries.
  if (bytes[5] & 0xc0) return result;
  const limit = Math.min(bytes.length, 10 + sync(bytes.subarray(6, 10)));
  for (let offset = 10; offset + 10 <= limit;) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = bytes[3] === 4 ? sync(bytes.subarray(offset + 4, offset + 8)) : new DataView(bytes.buffer).getUint32(offset + 4);
    if (!size || size > limit - offset - 10 || !/^[A-Z0-9]{4}$/.test(id)) break;
    const frame = bytes.subarray(offset + 10, offset + 10 + size);
    if (bytes[offset + 8] === 0 && bytes[offset + 9] === 0) {
      if (id === 'TIT2') result.title = text(frame).slice(0, 160);
      if (id === 'TPE1') result.artist = text(frame).slice(0, 120);
      if (id === 'APIC') {
        const endMime = frame.indexOf(0, 1);
        const mime = new TextDecoder().decode(frame.subarray(1, endMime));
        const wide = frame[0] === 1 || frame[0] === 2;
        let start = endMime + 2;
        while (start + 1 < frame.length && (frame[start] !== 0 || (wide && frame[start + 1] !== 0))) start += wide ? 2 : 1;
        start += wide ? 2 : 1;
        if (/^image\/(jpeg|png|webp)$/.test(mime) && start < frame.length) result.cover = new Blob([new Uint8Array(frame.subarray(start))], { type: mime });
      }
    }
    offset += 10 + size;
  }
  return result;
}
export async function prepareImport(file: File): Promise<StoredTrack> {
  validateMusicFile(file);
  const url = URL.createObjectURL(file);
  const audio = new Audio(); audio.preload = 'metadata';
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DECODE_TIMEOUT')), 12000);
      audio.onloadedmetadata = () => { clearTimeout(timeout); resolve(audio.duration); };
      audio.onerror = () => { clearTimeout(timeout); reject(new Error('FILE_CODEC')); };
      audio.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('FILE_CODEC');
    const metadata = await tags(file).catch(() => ({} as Awaited<ReturnType<typeof tags>>));
    const accent = metadata.cover ? await coverAccent(metadata.cover) : '#c3a2ed';
    return { id: `local-${crypto.randomUUID()}`, source: 'local', title: metadata.title || file.name.replace(/\.[^.]+$/, '').slice(0, 160),
      artist: metadata.artist || '', file, cover: metadata.cover, duration, bytes: file.size, importedAt: Date.now(), mood: 'calm', accent };
  } finally { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
}
async function coverAccent(cover: Blob): Promise<string> {
  try {
    const image = await createImageBitmap(cover, { resizeWidth: 24, resizeHeight: 24 });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
    const context = canvas.getContext('2d'); if (!context) { image.close(); return '#c3a2ed'; }
    context.drawImage(image, 0, 0); image.close();
    const data = context.getImageData(0, 0, 24, 24).data;
    let best = [195, 162, 237], weight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const rgb = [data[i], data[i + 1], data[i + 2]], high = Math.max(...rgb), low = Math.min(...rgb);
      const score = high - low;
      if (score > weight && high > 70 && high < 245) { best = rgb; weight = score; }
    }
    return '#' + best.map(value => Math.round(value * .6 + 255 * .4).toString(16).padStart(2, '0')).join('');
  } catch { return '#c3a2ed'; }
}
