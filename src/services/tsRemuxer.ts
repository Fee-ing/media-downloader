// tsRemuxer.ts
// 把「拼接后的 MPEG-TS（H.264 + AAC）」转封装为「非分片 MP4」。
// 适用范围：VOD HLS，单视频 PID(0x1B, H.264) + 可选 AAC 音频(0x0F/0x11)，无加密。
// 不支持：AES-128 加密、多节目、非 H.264/AAC 编码（这类请用 FFmpeg）。
//
// 纯 JS 实现，目的是在你的 Expo 项目里不引入原生依赖即可产出可播放的 .mp4。
// 若转换失败，调用方会回退为直接保存拼接后的 .ts（VLC / IINA / MX Player 均可播放）。

export function concatBytes(arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < len ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < len ? chars[c & 63] : '=';
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n >>> 0);
  return b;
}
function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

function box(type: string, ...p: Uint8Array[]): Uint8Array {
  const body = concatBytes(p);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, body.length + 8);
  head[4] = type.charCodeAt(0);
  head[5] = type.charCodeAt(1);
  head[6] = type.charCodeAt(2);
  head[7] = type.charCodeAt(3);
  return concatBytes([head, body]);
}

function fullBox(type: string, ver: number, flags: number, ...p: Uint8Array[]): Uint8Array {
  const vf = new Uint8Array([ver & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return box(type, vf, ...p);
}

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

const TS_PACKET = 188;
const SYNC = 0x47;

interface Frame {
  pts: number;
  dts: number;
  data: Uint8Array;
}

interface TrackInfo {
  pid: number;
  type: 'video' | 'audio';
  frames: Frame[];
  sps?: Uint8Array;
  pps?: Uint8Array;
  asc?: Uint8Array;
  width: number;
  height: number;
}

function parsePes(buf: Uint8Array, start: number): { streamId: number; pts: number; dts: number; data: Uint8Array } {
  const streamId = buf[start + 3];
  const flags = buf[start + 7];
  const hdrLen = buf[start + 8];
  const ptsDts = (flags >> 6) & 0x03;
  let pts = 0;
  let dts = 0;
  if (ptsDts & 0x02) {
    const p = start + 9;
    pts =
      ((buf[p] & 0x0e) << 29) |
      (buf[p + 1] << 22) |
      ((buf[p + 2] & 0xfe) << 14) |
      (buf[p + 3] << 7) |
      ((buf[p + 4] & 0xfe) >> 1);
    if (ptsDts & 0x01) {
      const d = p + 5;
      dts =
        ((buf[d] & 0x0e) << 29) |
        (buf[d + 1] << 22) |
        ((buf[d + 2] & 0xfe) << 14) |
        (buf[d + 3] << 7) |
        ((buf[d + 4] & 0xfe) >> 1);
    } else {
      dts = pts;
    }
  }
  const dataStart = start + 9 + hdrLen;
  return { streamId, pts: pts >>> 0, dts: dts >>> 0, data: buf.subarray(dataStart) };
}

function splitNals(es: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  const len = es.length;
  let i = 0;
  while (i < len) {
    if (es[i] === 0x00 && es[i + 1] === 0x00 && (es[i + 2] === 0x01 || (es[i + 2] === 0x00 && es[i + 3] === 0x01))) {
      const lead = es[i + 2] === 0x01 ? 3 : 4;
      let j = i + lead;
      let found = -1;
      while (j < len) {
        if (es[j] === 0x00 && es[j + 1] === 0x00 && (es[j + 2] === 0x01 || (es[j + 2] === 0x00 && es[j + 3] === 0x01))) {
          found = j;
          break;
        }
        j++;
      }
      const end = found === -1 ? len : found;
      if (end > i + lead) nals.push(es.subarray(i + lead, end));
      if (found === -1) break;
      i = found;
    } else {
      i++;
    }
  }
  return nals;
}

function nalType(nal: Uint8Array): number {
  return nal[0] & 0x1f;
}

function parseSpsSize(sps: Uint8Array): { width: number; height: number } {
  try {
    const rbsp: number[] = [];
    for (let i = 1; i < sps.length; i++) {
      if (i + 2 < sps.length && sps[i] === 0 && sps[i + 1] === 0 && sps[i + 2] === 0x03) {
        rbsp.push(sps[i], sps[i + 1]);
        i += 2;
        continue;
      }
      rbsp.push(sps[i]);
    }
    let bitPos = 0;
    const readBit = () => {
      const byte = rbsp[bitPos >> 3];
      const b = (byte >> (7 - (bitPos & 7))) & 1;
      bitPos++;
      return b;
    };
    const readBits = (n: number) => {
      let v = 0;
      for (let k = 0; k < n; k++) v = (v << 1) | readBit();
      return v;
    };
    const readUE = () => {
      let zeros = 0;
      while (readBit() === 0 && zeros < 32) zeros++;
      let val = 0;
      for (let k = 0; k < zeros; k++) val = (val << 1) | readBit();
      return (1 << zeros) - 1 + val;
    };
    readBits(8);
    readBits(8);
    readBits(8);
    readUE();
    const chroma = readUE();
    if (chroma === 3) readBits(1);
    const w = readUE();
    const h = readUE();
    return { width: w, height: h };
  } catch {
    return { width: 0, height: 0 };
  }
}

function nalsToAvcc(nals: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const n of nals) {
    parts.push(u32(n.length));
    parts.push(n);
  }
  return concatBytes(parts);
}

function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return concatBytes([
    u8(1),
    u8(sps[1]),
    u8(sps[2]),
    u8(sps[3]),
    u8(0xff),
    u8(0xe0 | 1),
    u16(sps.length),
    sps,
    u8(1),
    u16(pps.length),
    pps,
  ]);
}

function buildMp4a(asc: Uint8Array): Uint8Array {
  return concatBytes([u8(0), u8(0), u8(0), u8(0), u8(0), u8(0), asc]);
}

function buildEsds(asc: Uint8Array): Uint8Array {
  const decCfg = concatBytes([
    u8(0x04),
    u8(15 + asc.length + 1),
    u8(0x40),
    u8(0x15),
    u8(0),
    u8(0),
    u8(0),
    u8(0),
    u8(0),
    u8(0),
    u8(0x05),
    u8(asc.length),
    asc,
  ]);
  const slCfg = concatBytes([u8(0x06), u8(0x01), u8(0x02)]);
  const es = concatBytes([u8(0x03), u8(13 + asc.length + 3), u8(0), u16(1), u8(0), decCfg, slCfg]);
  return fullBox('esds', 0, 0, es);
}

function buildStsdVideo(sps: Uint8Array, pps: Uint8Array, width: number, height: number): Uint8Array {
  const avcC = buildAvcC(sps, pps);
  const avc1 = fullBox(
    'avc1',
    0,
    0,
    u8(0),
    u8(0),
    u8(0),
    u8(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    u8(0),
    new Uint8Array(31),
    u16(0x0018),
    u16(0xffff),
    avcC,
  );
  return fullBox('stsd', 0, 0, u32(1), avc1);
}

function buildStsdAudio(asc: Uint8Array): Uint8Array {
  const mp4a = fullBox(
    'mp4a',
    0,
    0,
    u8(0),
    u8(0),
    u8(0),
    u8(0),
    u16(1),
    u32(0),
    u32(0),
    u16(2),
    u16(16),
    u32(0),
    u16(0),
    buildEsds(asc),
  );
  return fullBox('stsd', 0, 0, u32(1), mp4a);
}

function buildStts(deltas: number[]): Uint8Array {
  const runs: { c: number; d: number }[] = [];
  for (const d of deltas) {
    if (runs.length && runs[runs.length - 1].d === d) runs[runs.length - 1].c++;
    else runs.push({ c: 1, d });
  }
  const body: Uint8Array[] = [u32(runs.length)];
  for (const r of runs) {
    body.push(u32(r.c));
    body.push(u32(r.d));
  }
  return fullBox('stts', 0, 0, ...body);
}

function buildCtts(offsets: number[]): Uint8Array {
  const body: Uint8Array[] = [u32(offsets.length)];
  for (const o of offsets) body.push(u32(1), u32(o));
  return fullBox('ctts', 0, 0, ...body);
}

function buildStbl(stsd: Uint8Array, sizes: number[], deltas: number[], ctts: Uint8Array | null): Uint8Array {
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map((s) => u32(s)));
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(sizes.length), u32(1));
  const stts = buildStts(deltas);
  const cttsBox = ctts ? buildCtts(ctts) : new Uint8Array(0);
  const stco = fullBox('stco', 0, 0, u32(1), u32(0));
  return box('stbl', stsd, stts, cttsBox, stsc, stsz, stco);
}

function wrapDelta(a: number, b: number): number {
  let d = (a - b) >>> 0;
  if (d > 0x80000000) d = (b - a) >>> 0;
  return d;
}

export function remuxTsToMp4(ts: Uint8Array): Uint8Array {
  // 1) 找 PMT pid（从 PAT）
  let pmtPid = -1;
  for (let i = 0; i + TS_PACKET <= ts.length && pmtPid < 0; i += TS_PACKET) {
    if (ts[i] !== SYNC) continue;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    if (pid !== 0) continue;
    const pusi = (ts[i + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const afc = (ts[i + 3] >> 4) & 0x03;
    let off = i + 4;
    if (afc & 0x02) off += ts[i + 4] + 1;
    const seg = ts.subarray(off, i + TS_PACKET);
    const ptr = seg[0];
    let idx = 1 + ptr;
    if (seg[idx] === 0x00) {
      const secLen = ((seg[idx + 1] & 0x0f) << 8) | seg[idx + 2];
      let k = idx + 3 + 5; // 跳过 table_id/section 头部到 program 循环起点
      const end = idx + 3 + secLen - 4;
      while (k + 4 <= end) {
        const program = (seg[k] << 8) | seg[k + 1];
        const pmt = ((seg[k + 2] & 0x1f) << 8) | seg[k + 3];
        if (program !== 0) pmtPid = pmt;
        k += 4;
      }
    }
  }
  if (pmtPid < 0) throw new Error('未找到 PMT');

  // 2) 解析 PMT，定位 video/audio PID
  const pidStreams = new Map<number, number>();
  for (let i = 0; i + TS_PACKET <= ts.length; i += TS_PACKET) {
    if (ts[i] !== SYNC) continue;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    if (pid !== pmtPid) continue;
    const pusi = (ts[i + 1] & 0x40) !== 0;
    if (!pusi) continue;
    const afc = (ts[i + 3] >> 4) & 0x03;
    let off = i + 4;
    if (afc & 0x02) off += ts[i + 4] + 1;
    const seg = ts.subarray(off, i + TS_PACKET);
    const ptr = seg[0];
    let idx = 1 + ptr;
    if (seg[idx] !== 0x02) continue;
    const secLen = ((seg[idx + 1] & 0x0f) << 8) | seg[idx + 2];
    const pil = ((seg[idx + 10] & 0x0f) << 8) | seg[idx + 11];
    let k = idx + 3 + 9 + pil;
    const end = idx + 3 + secLen - 4;
    while (k + 5 <= end) {
      const stype = seg[k];
      const spid = ((seg[k + 1] & 0x1f) << 8) | seg[k + 2];
      const esil = ((seg[k + 3] & 0x0f) << 8) | seg[k + 4];
      pidStreams.set(spid, stype);
      k += 5 + esil;
    }
  }

  const tracks = new Map<number, TrackInfo>();
  for (const [pid, stype] of pidStreams) {
    if (stype === 0x1b) tracks.set(pid, { pid, type: 'video', frames: [], width: 0, height: 0 });
    else if (stype === 0x0f || stype === 0x11) tracks.set(pid, { pid, type: 'audio', frames: [], width: 0, height: 0 });
  }

  // 3) 按 PID 重组 PES
  const pesBuf = new Map<number, { start: boolean; chunks: Uint8Array[] }>();
  const ingest = (full: Uint8Array, track: TrackInfo) => {
    try {
      const pes = parsePes(full, 0);
      if (track.type === 'video') {
        const nals = splitNals(pes.data);
        const out: Uint8Array[] = [];
        for (const n of nals) {
          const t = nalType(n);
          if (t === 7 && !track.sps) {
            track.sps = n;
            const sz = parseSpsSize(n);
            track.width = sz.width;
            track.height = sz.height;
          } else if (t === 8 && !track.pps) {
            track.pps = n;
          }
          out.push(n);
        }
        const key = nals.some((n) => {
          const t = nalType(n);
          return t === 5 || t === 6 || t === 9;
        });
        track.frames.push({ pts: pes.pts, dts: pes.dts, data: nalsToAvcc(out) });
      } else {
        const es = pes.data;
        let p = 0;
        while (p + 7 < es.length && es[p] === 0xff && (es[p + 1] & 0xf0) === 0xf0) {
          const crc = (es[p + 1] & 0x01) === 0 ? 9 : 7;
          const frameLen = ((es[p + 3] & 0x03) << 11) | (es[p + 4] << 3) | (es[p + 5] >> 5);
          if (p + frameLen > es.length) break;
          if (!track.asc) {
            const profile = (es[p + 2] >> 6) + 1;
            const sf = (es[p + 2] >> 2) & 0x0f;
            const chan = ((es[p + 2] & 0x01) << 2) | (es[p + 3] >> 6);
            track.asc = concatBytes([u8(((profile << 3) | (sf >> 1)) & 0xff), u8(((sf << 7) | (chan << 3)) & 0xff)]);
          }
          track.frames.push({ pts: pes.pts, dts: pes.dts, data: es.subarray(p + crc, p + frameLen) });
          p += frameLen;
        }
      }
    } catch {
      // 跳过损坏 PES
    }
  };

  for (let i = 0; i + TS_PACKET <= ts.length; i += TS_PACKET) {
    if (ts[i] !== SYNC) continue;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    const track = tracks.get(pid);
    if (!track) continue;
    const pusi = (ts[i + 1] & 0x40) !== 0;
    const afc = (ts[i + 3] >> 4) & 0x03;
    let off = i + 4;
    if (afc & 0x02) off += ts[i + 4] + 1;
    // 仅当「无 payload」时跳过：afc=00(保留) / afc=10(仅适配字段) 没有数据；
    // afc=01(仅负载) 与 afc=11(适配+负载) 都含有效 payload，必须处理。
    if ((afc & 0x01) === 0) continue;
    const payload = ts.subarray(off, i + TS_PACKET);
    let acc = pesBuf.get(pid);
    if (pusi) {
      if (acc && acc.start) ingest(concatBytes(acc.chunks), track);
      pesBuf.set(pid, { start: true, chunks: [payload] });
    } else {
      if (!acc) acc = { start: false, chunks: [] };
      acc.chunks.push(payload);
      pesBuf.set(pid, acc);
    }
  }
  for (const [pid, acc] of pesBuf) {
    const track = tracks.get(pid);
    if (acc && acc.start && track) ingest(concatBytes(acc.chunks), track);
  }

  // 4) 组装 MP4
  const video = [...tracks.values()].find((t) => t.type === 'video');
  const audio = [...tracks.values()].find((t) => t.type === 'audio');
  if (!video || !video.sps || !video.pps) throw new Error('缺少 H.264 SPS/PPS，无法封装 MP4');

  const timescale = 90000;
  const videoFrames = video.frames.slice().sort((a, b) => a.dts - b.dts);
  const audioFrames = audio ? audio.frames.slice().sort((a, b) => a.dts - b.dts) : [];

  const vSizes: number[] = [];
  const vDeltas: number[] = [];
  const vCtts: number[] = [];
  let prevDts = videoFrames[0].dts;
  for (const f of videoFrames) {
    vSizes.push(f.data.length);
    vDeltas.push(wrapDelta(f.dts, prevDts));
    let off = (f.pts - f.dts) >>> 0;
    if (off > 0x80000000) off = (f.dts - f.pts) >>> 0;
    vCtts.push(off);
    prevDts = f.dts;
  }
  const aSizes: number[] = [];
  const aDeltas: number[] = [];
  let aPrev = audioFrames.length ? audioFrames[0].dts : 0;
  for (const f of audioFrames) {
    aSizes.push(f.data.length);
    aDeltas.push(wrapDelta(f.dts, aPrev));
    aPrev = f.dts;
  }

  const vData = concatBytes(videoFrames.map((f) => f.data));
  const aData = audio ? concatBytes(audioFrames.map((f) => f.data)) : new Uint8Array(0);

  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(videoFrames[videoFrames.length - 1].dts || 0),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00]),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  );

  const vStco = fullBox('stco', 0, 0, u32(1), u32(0)); // offset 稍后回填
  const aStco = audio && audio.asc ? fullBox('stco', 0, 0, u32(1), u32(0)) : new Uint8Array(0);

  function videoTrak(): Uint8Array {
    const stsd = buildStsdVideo(video!.sps!, video!.pps!, video!.width, video!.height);
    const stbl = buildStbl(stsd, vSizes, vDeltas, buildCtts(vCtts));
    // 回填 stco
    const finalStbl = box('stbl', stsd, buildStts(vDeltas), buildCtts(vCtts), fullBox('stsc', 0, 0, u32(1), u32(1), u32(vSizes.length), u32(1)), fullBox('stsz', 0, 0, u32(0), u32(vSizes.length), ...vSizes.map((s) => u32(s))), vStco);
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const minf = box('minf', box('vmhd', u8(0), u8(0), u8(0), u8(0), u16(0), u16(0), u16(0)), dinf, finalStbl);
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(videoFrames[videoFrames.length - 1].dts || 0), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, ascii('vide'), u8(0), u8(0), u8(0), u8(0), ascii('VideoHandler'));
    const mdia = box('mdia', mdhd, hdlr, minf);
    const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(0), u16(video!.width || 1280), u16(video!.height || 720), u32(0x00480000), u32(0x00480000), u32(0), u32(0), u32(0), u16(0), u16(0));
    return box('trak', tkhd, mdia);
  }

  function audioTrak(): Uint8Array {
    const stsd = buildStsdAudio(audio!.asc!);
    const finalStbl = box('stbl', stsd, buildStts(aDeltas), fullBox('stsc', 0, 0, u32(1), u32(1), u32(aSizes.length), u32(1)), fullBox('stsz', 0, 0, u32(0), u32(aSizes.length), ...aSizes.map((s) => u32(s))), aStco);
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
    const minf = box('minf', smhd, dinf, finalStbl);
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(audioFrames[audioFrames.length - 1].dts || 0), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, ascii('soun'), u8(0), u8(0), u8(0), u8(0), ascii('SoundHandler'));
    const mdia = box('mdia', mdhd, hdlr, minf);
    const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(2), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u32(0x00480000), u32(0x00480000), u32(0), u32(0), u32(0), u16(0), u16(0));
    return box('trak', tkhd, mdia);
  }

  // 先计算 moov 大小，回填 stco 的 chunk 偏移
  // 计算 moov 时需要先构造 moov。我们构造一次得到大小，再回填 stco 后重建 moov。
  function buildMoov(): Uint8Array {
    const traks = [videoTrak()];
    if (audio && audio.asc) traks.push(audioTrak());
    return box('moov', mvhd, ...traks);
  }
  let moov = buildMoov();
  const mdatOffset = ftyp.length + moov.length + 8;
  // 回填：video chunk 起点 = mdatOffset；audio chunk 起点 = mdatOffset + vData.length
  const vOffset = mdatOffset;
  const aOffset = mdatOffset + vData.length;
  // 直接重写 stco 的 offset（stco 结构：size(4)+type(4)+version(1)+flags(3)+entryCount(4)+offset(4)）
  function setStcoOffset(stco: Uint8Array, offset: number): Uint8Array {
    const out = stco.slice();
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(out.length - 4, offset >>> 0);
    return out;
  }
  // 重新构建带正确 stco 的 moov
  function buildMoovFixed(): Uint8Array {
    const vStcoFixed = setStcoOffset(vStco, vOffset);
    const aStcoFixed = audio && audio.asc ? setStcoOffset(aStco, aOffset) : new Uint8Array(0);
    function videoTrakFixed(): Uint8Array {
      const stsd = buildStsdVideo(video!.sps!, video!.pps!, video!.width, video!.height);
      const stbl = box('stbl', stsd, buildStts(vDeltas), buildCtts(vCtts), fullBox('stsc', 0, 0, u32(1), u32(1), u32(vSizes.length), u32(1)), fullBox('stsz', 0, 0, u32(0), u32(vSizes.length), ...vSizes.map((s) => u32(s))), vStcoFixed);
      const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
      const minf = box('minf', box('vmhd', u8(0), u8(0), u8(0), u8(0), u16(0), u16(0), u16(0)), dinf, stbl);
      const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(videoFrames[videoFrames.length - 1].dts || 0), u16(0x55c4), u16(0));
      const hdlr = fullBox('hdlr', 0, 0, ascii('vide'), u8(0), u8(0), u8(0), u8(0), ascii('VideoHandler'));
      const mdia = box('mdia', mdhd, hdlr, minf);
      const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(0), u16(video!.width || 1280), u16(video!.height || 720), u32(0x00480000), u32(0x00480000), u32(0), u32(0), u32(0), u16(0), u16(0));
      return box('trak', tkhd, mdia);
    }
    function audioTrakFixed(): Uint8Array {
      const stsd = buildStsdAudio(audio!.asc!);
      const stbl = box('stbl', stsd, buildStts(aDeltas), fullBox('stsc', 0, 0, u32(1), u32(1), u32(aSizes.length), u32(1)), fullBox('stsz', 0, 0, u32(0), u32(aSizes.length), ...aSizes.map((s) => u32(s))), aStcoFixed);
      const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
      const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
      const minf = box('minf', smhd, dinf, stbl);
      const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(audioFrames[audioFrames.length - 1].dts || 0), u16(0x55c4), u16(0));
      const hdlr = fullBox('hdlr', 0, 0, ascii('soun'), u8(0), u8(0), u8(0), u8(0), ascii('SoundHandler'));
      const mdia = box('mdia', mdhd, hdlr, minf);
      const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(2), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u32(0x00480000), u32(0x00480000), u32(0), u32(0), u32(0), u16(0), u16(0));
      return box('trak', tkhd, mdia);
    }
    const traks = [videoTrakFixed()];
    if (audio && audio.asc) traks.push(audioTrakFixed());
    return box('moov', mvhd, ...traks);
  }
  moov = buildMoovFixed();

  const mdatHead = new Uint8Array(8);
  new DataView(mdatHead.buffer).setUint32(0, vData.length + aData.length + 8);
  mdatHead[4] = 'm'.charCodeAt(0);
  mdatHead[5] = 'd'.charCodeAt(0);
  mdatHead[6] = 'a'.charCodeAt(0);
  mdatHead[7] = 't'.charCodeAt(0);

  return concatBytes([ftyp, moov, mdatHead, vData, aData]);
}
