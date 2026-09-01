import { File, FileHandle, FileMode } from 'expo-file-system';

/**
 * 纯 JS 的 fragmented MP4（fMP4 / ISO BMFF）合并器。
 *
 * 针对 DASH 音画分离资源（如 B 站 m4s 视频轨 + 独立伴音轨）：
 * 视频轨文件与音频轨文件都是「ftyp + moov + (moof + mdat)*」的 fMP4，
 * 各自只含一条轨道（视频轨只有视频 trak，音频轨只有音频 trak）。
 *
 * 合并思路：
 *  - 取出视频 moov 的 mvhd / 视频 trak / 视频 mvex 与音频 moov 的音频 trak / 音频 mvex；
 *  - 组装新的 moov（mvhd + 视频 trak + 音频 trak + 合并 mvex）；
 *  - 视频 trak 的 track_ID 统一为 1，音频 trak 的 track_ID 统一为 2；
 *  - 原样拼接视频 (moof+mdat)* 段，再拼接音频 (moof+mdat)* 段；
 *  - 音频 moof 内的 tfhd.track_ID 重写为 2，若携带 base_data_offset 则补偿拼接位移；
 *  - mdat 数据本身不变。
 *
 * 全程流式读写（FileHandle + 1MB 块），避免把大文件整体载入 JS 内存。
 * 任何结构不符合预期的情况都会抛错，由调用方回退为「仅下载视频轨」。
 */

const COPY_CHUNK = 1024 * 1024; // 复制 mdat 的分块大小
const MAX_MOOF_SIZE = 16 * 1024 * 1024; // moof 理论上远小于此，防异常输入

const AUDIO_SAMPLE_ENTRIES = [
  'mp4a', 'Opus', 'opus', 'alac', 'ac-3', 'ec-3', 'fLaC', 'flac', 'enca', 'sowt', 'twos', 'lpcm', 'samr', 'sawb',
];
const VIDEO_SAMPLE_ENTRIES = [
  'avc1', 'avc3', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'dvav', 'dva1', 'dvh1', 'dvhe', 'encv', 'jpeg', 'png ',
];

interface BoxSlice {
  type: string;
  start: number; // 相对宿主字节数组的起始偏移
  end: number; // 结束偏移（不含）
}

interface Fmp4Scan {
  ftyp: { start: number; end: number } | null;
  moovBytes: Uint8Array;
  /** 媒体段：moof 到下一个 moof 之前的连续字节区间（含紧随的 mdat） */
  segments: { start: number; end: number }[];
}

interface TrackInfo {
  trakBox: BoxSlice;
  trakBytes: Uint8Array;
  kind: 'video' | 'audio';
  trackId: number;
  /** tkhd.track_ID 相对 trak 起点的偏移 */
  tkhdTrackIdOffset: number;
}

interface ParsedMoov {
  mvhd: Uint8Array | null;
  tracks: TrackInfo[];
  mvex: BoxSlice | null;
}

interface TrexInfo {
  start: number; // 相对宿主（moov）起点
  end: number;
  trackIdOffset: number; // trex 内 track_ID 相对 trex 起点
  trackId: number;
}

/* ------------------------------------------------------------------ */
/* 字节工具                                                             */
/* ------------------------------------------------------------------ */

function readUint64BE(view: DataView, offset: number): number {
  const hi = view.getUint32(offset);
  const lo = view.getUint32(offset + 4);
  if (hi > 0x1fffff) return Number.MAX_SAFE_INTEGER; // 超出 JS 安全整数
  return hi * 4294967296 + lo;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function asciiToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** 生成一个 box（自动计算 size 头） */
function buildBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out.set(asciiToBytes(type), 4);
  out.set(payload, 8);
  return out;
}

/** 遍历字节数组中的顶层 box（bytes 即 box 列表本身，不含容器 header） */
function forEachBox(bytes: Uint8Array, cb: (box: BoxSlice) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) break;
      size = readUint64BE(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerSize || offset + size > bytes.byteLength) break;
    cb({ type: ascii(bytes, offset + 4, 4), start: offset, end: offset + size });
    offset += size;
  }
}

/** 遍历容器 box 的子 box（bytes 为完整容器，含自身 header；box 偏移相对 bytes） */
function forEachChild(bytes: Uint8Array, cb: (box: BoxSlice) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerSize = 8;
  if (view.getUint32(0) === 1) headerSize = 16;
  let offset = headerSize;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.byteLength) break;
    cb({ type: ascii(bytes, offset + 4, 4), start: offset, end: offset + size });
    offset += size;
  }
}

/* ------------------------------------------------------------------ */
/* 文件扫描                                                             */
/* ------------------------------------------------------------------ */

/** 读取一个 box 的 header（8/16 字节），返回 size/type；handle.offset 会被推进 */
function readBoxHeader(handle: FileHandle, limit: number): { size: number; type: string; headerSize: number } | null {
  const boxStart = handle.offset;
  if (boxStart === null || boxStart + 8 > limit) return null;
  const head = handle.readBytes(8);
  const view = new DataView(head.buffer, head.byteOffset, 8);
  let size = view.getUint32(0);
  const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
  let headerSize = 8;
  if (size === 1) {
    const ext = handle.readBytes(8);
    const extView = new DataView(ext.buffer, ext.byteOffset, 8);
    size = readUint64BE(extView, 0);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - boxStart; // size=0 表示 box 延伸到文件尾
  }
  if (size < headerSize) return null;
  return { size, type, headerSize };
}

/** 顺序扫描文件的顶层 box，提取 ftyp / moov / 媒体段 */
async function scanFmp4(file: File): Promise<Fmp4Scan> {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const total = handle.size ?? 0;
    if (total < 16) throw new Error('文件过小，不是有效的 MP4');
    let ftyp: { start: number; end: number } | null = null;
    let moovBytes: Uint8Array | null = null;
    const segments: { start: number; end: number }[] = [];
    let offset = 0;
    let currentSegment: { start: number } | null = null;

    while (offset + 8 <= total) {
      handle.offset = offset;
      const header = readBoxHeader(handle, total);
      if (!header) break;
      const end = offset + header.size;
      if (end > total) break;

      if (header.type === 'ftyp' && !ftyp) {
        ftyp = { start: offset, end };
      } else if (header.type === 'moov' && !moovBytes) {
        // 只保留 moov 的 payload（子 box 列表），parseMoov 从 payload 开始解析
        handle.offset = offset + header.headerSize;
        moovBytes = handle.readBytes(header.size - header.headerSize);
      } else if (header.type === 'moof') {
        if (currentSegment) {
          segments.push({ start: currentSegment.start, end: offset });
        }
        currentSegment = { start: offset };
      }
      offset = end;
    }
    if (currentSegment) {
      segments.push({ start: currentSegment.start, end: offset });
    }
    if (!moovBytes) throw new Error('缺少 moov box');
    return { ftyp, moovBytes, segments };
  } finally {
    handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* moov 解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 在完整容器 box（含自身 header）内查找指定类型的子 box，
 * 返回其在宿主 bytes 内的偏移。先跳过容器自身的 header，只遍历 payload。
 */
function findChild(bytes: Uint8Array, type: string): BoxSlice | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8; // 跳过容器自身 header
  const first = view.getUint32(0);
  if (first === 1) offset = 16; // 64 位扩展 size
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.byteLength) break;
    if (ascii(bytes, offset + 4, 4) === type) {
      return { type, start: offset, end: offset + size };
    }
    offset += size;
  }
  return null;
}

/** 从 mdia 里找 stsd 的第一个 sample entry 类型（avc1 / mp4a 等） */
function findSampleEntryType(mdiaBytes: Uint8Array): string | null {
  // mdia → minf → stbl → stsd
  const minf = findChild(mdiaBytes, 'minf');
  if (!minf) return null;
  const minfBytes = mdiaBytes.subarray(minf.start, minf.end);
  const stbl = findChild(minfBytes, 'stbl');
  if (!stbl) return null;
  const stblBytes = minfBytes.subarray(stbl.start, stbl.end);
  const stsd = findChild(stblBytes, 'stsd');
  if (!stsd) return null;
  const stsdBytes = stblBytes.subarray(stsd.start, stsd.end);
  if (stsdBytes.byteLength < 20) return null;
  // stsd: box header(8) + version/flags(4) + entry_count(4)，entry_count 在 offset 12
  const view = new DataView(stsdBytes.buffer, stsdBytes.byteOffset, stsdBytes.byteLength);
  const entryCount = view.getUint32(12);
  if (entryCount < 1) return null;
  return ascii(stsdBytes, 20, 4).trim();
}

/** 分析单个 trak，返回轨道类型与 track_ID 位置 */
function analyzeTrak(trakBytes: Uint8Array): Omit<TrackInfo, 'trakBox' | 'trakBytes'> | null {
  const tkhd = findChild(trakBytes, 'tkhd');
  if (!tkhd) return null;
  const view = new DataView(trakBytes.buffer, trakBytes.byteOffset + tkhd.start, tkhd.end - tkhd.start);
  const version = view.getUint8(8);
  // tkhd: header(8) + version/flags(4) + creation + modification + track_ID
  // v0: creation 4 + modification 4 → track_ID@20；v1: creation 8 + modification 8 → track_ID@28
  const trackIdOffset = version === 1 ? 28 : 20;
  if (tkhd.end - tkhd.start < trackIdOffset + 4) return null;
  const trackId = view.getUint32(trackIdOffset);

  let kind: 'video' | 'audio' | null = null;
  const mdia = findChild(trakBytes, 'mdia');
  if (mdia) {
    const sampleEntryType = findSampleEntryType(trakBytes.subarray(mdia.start, mdia.end));
    if (sampleEntryType) {
      if (AUDIO_SAMPLE_ENTRIES.includes(sampleEntryType)) kind = 'audio';
      else if (VIDEO_SAMPLE_ENTRIES.includes(sampleEntryType)) kind = 'video';
    }
  }
  if (!kind) return null;
  return { kind, trackId, tkhdTrackIdOffset: tkhd.start + trackIdOffset };
}

function parseMoov(moovBytes: Uint8Array): ParsedMoov {
  const result: ParsedMoov = { mvhd: null, tracks: [], mvex: null };
  forEachBox(moovBytes, box => {
    if (box.type === 'mvhd') {
      result.mvhd = moovBytes.subarray(box.start, box.end);
    } else if (box.type === 'trak') {
      const info = analyzeTrak(moovBytes.subarray(box.start, box.end));
      if (info) {
        result.tracks.push({
          ...info,
          trakBox: box,
          trakBytes: moovBytes.subarray(box.start, box.end),
        });
      }
    } else if (box.type === 'mvex') {
      result.mvex = box;
    }
  });
  return result;
}

function extractTrexList(moovBytes: Uint8Array, mvex: BoxSlice): TrexInfo[] {
  const list: TrexInfo[] = [];
  const mvexBytes = moovBytes.subarray(mvex.start, mvex.end);
  forEachChild(mvexBytes, box => {
    if (box.type !== 'trex') return;
    const view = new DataView(mvexBytes.buffer, mvexBytes.byteOffset + box.start, box.end - box.start);
    // trex: header(8) + version/flags(4) + track_ID(4) → track_ID@12
    if (box.end - box.start < 16) return;
    list.push({ start: mvex.start + box.start, end: mvex.start + box.end, trackIdOffset: 12, trackId: view.getUint32(12) });
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* moov 重组                                                            */
/* ------------------------------------------------------------------ */

function setTrackId(bytes: Uint8Array, trackIdOffset: number, newId: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(trackIdOffset, newId);
}

function rewriteTrex(moovBytes: Uint8Array, trex: TrexInfo, newId: number): Uint8Array {
  const out = moovBytes.slice(trex.start, trex.end);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(trex.trackIdOffset, newId);
  return out;
}

/** 读取 mvhd 的时长（秒） */
function mvhdSeconds(mvhd: Uint8Array): number | null {
  const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
  const version = view.getUint8(8);
  if (version === 1) {
    if (mvhd.byteLength < 32) return null;
    const timescale = view.getUint32(20);
    return timescale > 0 ? readUint64BE(view, 24) / timescale : 0;
  }
  if (mvhd.byteLength < 20) return null;
  const timescale = view.getUint32(12);
  return timescale > 0 ? view.getUint32(16) / timescale : 0;
}

/** 更新 mvhd：next_track_ID=3，必要时把 duration 扩展到较长的轨道 */
function patchMvhd(mvhd: Uint8Array, minSeconds?: number): Uint8Array {
  const out = new Uint8Array(mvhd);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const version = view.getUint8(8);
  // mvhd v0: next_track_ID@96；v1: next_track_ID@108
  const nextTrackIdOffset = version === 1 ? 108 : 96;
  if (out.byteLength >= nextTrackIdOffset + 4) {
    view.setUint32(nextTrackIdOffset, 3);
  }
  if (minSeconds !== undefined && minSeconds > 0) {
    const timescaleOffset = version === 1 ? 20 : 12;
    if (out.byteLength >= timescaleOffset + 4) {
      const timescale = view.getUint32(timescaleOffset);
      if (timescale > 0) {
        const newDuration = Math.round(minSeconds * timescale);
        if (version === 1) {
          // 64 位 duration @24
          if (out.byteLength >= 32) {
            view.setUint32(24, Math.floor(newDuration / 4294967296));
            view.setUint32(28, newDuration >>> 0);
          }
        } else if (newDuration <= 0xffffffff) {
          // v0 的 duration 为 32 位 @16；溢出（超长视频）时保留原值
          view.setUint32(16, newDuration);
        }
      }
    }
  }
  return out;
}

/**
 * 组装新的 moov：
 * 视频轨 track_ID → 1，音频轨 track_ID → 2；
 * mvex 合并为视频 trex + 音频 trex；
 * mvhd 时长取两条轨道中较长者。
 */
function buildMoov(
  videoMoov: Uint8Array,
  videoTrak: TrackInfo,
  audioMoov: Uint8Array,
  audioTrak: TrackInfo,
): Uint8Array | null {
  const vp = parseMoov(videoMoov);
  const ap = parseMoov(audioMoov);
  if (!vp.mvhd || !vp.mvex || !ap.mvhd || !ap.mvex) return null;
  const videoTrex = extractTrexList(videoMoov, vp.mvex).find(t => t.trackId === videoTrak.trackId);
  const audioTrex = extractTrexList(audioMoov, ap.mvex).find(t => t.trackId === audioTrak.trackId);
  if (!videoTrex || !audioTrex) return null;

  // 时长取较长者
  const vSeconds = mvhdSeconds(vp.mvhd);
  const aSeconds = mvhdSeconds(ap.mvhd);
  const minSeconds =
    vSeconds !== null && aSeconds !== null ? Math.max(vSeconds, aSeconds) : undefined;

  const parts: Uint8Array[] = [];

  // 1. mvhd（用视频的，更新 next_track_ID 与时长）
  parts.push(patchMvhd(vp.mvhd, minSeconds));

  // 2. 视频 trak（track_ID → 1）
  const vTrak = new Uint8Array(videoTrak.trakBytes);
  if (videoTrak.trackId !== 1) setTrackId(vTrak, videoTrak.tkhdTrackIdOffset, 1);
  parts.push(vTrak);

  // 3. 音频 trak（track_ID → 2）
  const aTrak = new Uint8Array(audioTrak.trakBytes);
  setTrackId(aTrak, audioTrak.tkhdTrackIdOffset, 2);
  parts.push(aTrak);

  // 4. mvex（视频 trex + 音频 trex）
  parts.push(buildBox('mvex', concat([
    rewriteTrex(videoMoov, videoTrex, videoTrak.trackId !== 1 ? 1 : videoTrak.trackId),
    rewriteTrex(audioMoov, audioTrex, 2),
  ])));

  // 5. 其它 moov 顶层 box（udta 等，按视频文件的保留）
  forEachBox(videoMoov, box => {
    if (box.type === 'mvhd' || box.type === 'trak' || box.type === 'mvex') return;
    parts.push(videoMoov.subarray(box.start, box.end));
  });

  return buildBox('moov', concat(parts));
}

/* ------------------------------------------------------------------ */
/* 媒体段复制（流式）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 重写段内所有 moof/traf/tfhd：
 *  - track_ID：fromId → toId；
 *  - base_data_offset（flags bit0）：补偿拼接位移 baseOffsetDelta。
 */
function rewriteSegmentTrackIds(
  segmentBytes: Uint8Array,
  fromId: number,
  toId: number,
  baseOffsetDelta: number,
): Uint8Array {
  forEachBox(segmentBytes, moofBox => {
    if (moofBox.type !== 'moof') return;
    const moofBytes = segmentBytes.subarray(moofBox.start, moofBox.end);
    forEachChild(moofBytes, trafBox => {
      if (trafBox.type !== 'traf') return;
      const trafBytes = moofBytes.subarray(trafBox.start, trafBox.end);
      forEachChild(trafBytes, tfhdBox => {
        if (tfhdBox.type !== 'tfhd') return;
        if (trafBytes.byteLength - tfhdBox.start < 16) return;
        const abs = moofBox.start + trafBox.start + tfhdBox.start;
        const view = new DataView(segmentBytes.buffer, segmentBytes.byteOffset + abs, segmentBytes.byteLength - abs);
        // tfhd: header(8) + version/flags(4) + track_ID(4) → track_ID@12
        if (view.getUint32(12) === fromId) view.setUint32(12, toId);
        // flags bit0 = base-data-offset-present；base_data_offset 为 64 位，位于 @16
        const flags = view.getUint32(8);
        if ((flags & 0x1) !== 0 && baseOffsetDelta !== 0 && segmentBytes.byteLength - abs >= 24) {
          const hi = view.getUint32(16);
          const lo = view.getUint32(20);
          const combined = hi * 4294967296 + lo + baseOffsetDelta;
          view.setUint32(16, Math.floor(combined / 4294967296));
          view.setUint32(20, combined >>> 0);
        }
      });
    });
  });
  return segmentBytes;
}

/** 原样分块复制字节区间 */
async function copyRaw(src: FileHandle, dst: FileHandle, start: number, end: number): Promise<void> {
  let offset = start;
  while (offset < end) {
    src.offset = offset;
    const length = Math.min(COPY_CHUNK, end - offset);
    const chunk = src.readBytes(length);
    if (chunk.byteLength === 0) throw new Error('读取源文件失败');
    dst.writeBytes(chunk);
    offset += chunk.byteLength;
  }
}

/**
 * 复制一个媒体段：
 *  - moof（段首）读入内存，需要时重写 tfhd.track_ID / base_data_offset；
 *  - 其余（mdat 等）原样分块复制，不改内容。
 */
async function copyMediaSegment(
  src: FileHandle,
  dst: FileHandle,
  segment: { start: number; end: number },
  fromId: number,
  toId: number,
): Promise<void> {
  src.offset = segment.start;
  const header = readBoxHeader(src, segment.end);
  if (!header || header.type !== 'moof' || header.size > MAX_MOOF_SIZE) {
    // 结构异常（非 moof 开头），整段原样复制
    await copyRaw(src, dst, segment.start, segment.end);
    return;
  }
  const moofSize = header.size;
  src.offset = segment.start;
  const moofBytes = src.readBytes(moofSize);
  // 拼接后该 moof 的 base_data_offset 需补偿位移 = 当前输出位置 - 原始文件位置
  const baseOffsetDelta = (dst.offset ?? 0) - segment.start;
  const outBytes =
    fromId !== toId || baseOffsetDelta !== 0
      ? rewriteSegmentTrackIds(moofBytes, fromId, toId, baseOffsetDelta)
      : moofBytes;
  dst.writeBytes(outBytes);
  await copyRaw(src, dst, segment.start + moofSize, segment.end);
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 将「视频轨 fMP4」与「音频轨 fMP4」合并为单个 fMP4（含双轨，扩展名建议 .mp4）。
 *
 * @throws 结构不匹配 / 非 fMP4 / 轨道缺失等任何异常，由调用方回退。
 */
export async function muxFragmentedMp4Files(
  videoFile: File,
  audioFile: File,
  outputFile: File,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const videoScan = await scanFmp4(videoFile);
  const audioScan = await scanFmp4(audioFile);
  if (!videoScan.ftyp) throw new Error('视频文件缺少 ftyp');

  const vp = parseMoov(videoScan.moovBytes);
  const ap = parseMoov(audioScan.moovBytes);
  const videoTrak = vp.tracks.find(t => t.kind === 'video');
  const audioTrak = ap.tracks.find(t => t.kind === 'audio');
  if (!videoTrak || !audioTrak) {
    throw new Error('未找到可合并的视频轨/音轨');
  }

  const newMoov = buildMoov(videoScan.moovBytes, videoTrak, audioScan.moovBytes, audioTrak);
  if (!newMoov) throw new Error('轨道信息不完整，无法合并');

  if (outputFile.exists) outputFile.delete();
  outputFile.create({ intermediates: true, overwrite: true });
  const dst = outputFile.open(FileMode.WriteOnly);

  const report = (ratio: number) => onProgress?.(Math.min(1, Math.max(0, ratio)));

  try {
    // ftyp（视频文件的）
    if (videoScan.ftyp) {
      const src = videoFile.open(FileMode.ReadOnly);
      try {
        src.offset = videoScan.ftyp.start;
        dst.writeBytes(src.readBytes(videoScan.ftyp.end - videoScan.ftyp.start));
      } finally {
        src.close();
      }
    }
    report(0.02);

    // moov（新组装）
    dst.writeBytes(newMoov);
    report(0.04);

    // 视频段（track_ID → 1）
    const vSrc = videoFile.open(FileMode.ReadOnly);
    try {
      for (let i = 0; i < videoScan.segments.length; i++) {
        await copyMediaSegment(vSrc, dst, videoScan.segments[i], videoTrak.trackId, 1);
        report(0.04 + (0.48 * (i + 1)) / Math.max(1, videoScan.segments.length));
      }
    } finally {
      vSrc.close();
    }

    // 音频段（track_ID → 2）
    const aSrc = audioFile.open(FileMode.ReadOnly);
    try {
      for (let i = 0; i < audioScan.segments.length; i++) {
        await copyMediaSegment(aSrc, dst, audioScan.segments[i], audioTrak.trackId, 2);
        report(0.52 + (0.48 * (i + 1)) / Math.max(1, audioScan.segments.length));
      }
    } finally {
      aSrc.close();
    }

    report(1);
  } finally {
    dst.close();
  }
}
