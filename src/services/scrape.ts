/**
 * 通用媒体抓取方法。
 *
 * 页面脚本（extractor.ts）只负责「把候选捞出来」，不管好坏、不管重复；
 * 这里负责「把候选变成可展示的条目」，是整条链路唯一的收口：
 *
 *   页面脚本候选 → 归一 → 过滤 → 去重合并 → 打分排序 → 截断 → MediaItem
 *
 * 之所以要在这里再过一遍，是因为页面脚本拿不到响应头（跨源 no-cors），
 * 只能按 URL 特征与 initiatorType 粗筛，误报在所难免，需要一次统一终审。
 *
 * 打分的意义在于：可播放性校验有并发上限（TIMING.VIDEO_PROBE_MAX），
 * 命中上限时只能挑最可能是正片的那些去校验，排序错了就等于白抓。
 */

import { LIMITS } from '../constants';
import type {
  MediaItem,
  RawScrapePayload,
  VideoStreamKind,
} from '../types';
import { fileNameFromUrl } from '../utils/url';
import {
  baseScore,
  classifyStream,
  isJunkUrl,
  isManifestUrl,
  normalizeForDedupe,
} from './videoRules';

export interface ScrapeStats {
  /** 页面是否通过 MSE 播放（blob: 源） */
  mse: boolean;
  /** 页面上报的 blob: 视频数量 */
  blobVideos: number;
  /** srcObject（MediaStream）视频数量 */
  streamVideos: number;
  /** 页面层交上来的候选数 */
  rawVideos: number;
  /** 被本层规则丢弃的候选数 */
  dropped: number;
}

export interface ScrapeOutcome {
  images: MediaItem[];
  videos: MediaItem[];
  /** 一条都没抓到时给用户看的解释 */
  hint?: string;
  stats: ScrapeStats;
}

/** 归一化后的候选资源（与 MediaItem 一一对应，但还没分配 id） */
interface Candidate {
  url: string;
  title?: string;
  poster?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  source?: string;
  contentType?: string;
  fallbackUrl?: string;
  headers?: Record<string, string>;
  viaNetwork?: boolean;
  /** 请求发起者（video / audio / fetch / xmlhttprequest），来自 Resource Timing */
  initiator?: string;
  probeOk?: boolean;
  streamKind?: VideoStreamKind;
  score: number;
}

function shortTitle(raw: string | undefined, url: string): string {
  const text = (raw || '').trim();
  if (text) return text.slice(0, 120);
  return fileNameFromUrl(url);
}

/**
 * 候选打分。
 *
 * 基础分来自来源（DOM 里的 <video> 92 分，网络层嗅探 64 分…），
 * 再按「有没有元数据 / 有没有响应头佐证」加减分。
 * 页面脚本已经算过一次，这里重算是为了统一口径，让排序与截断有同一把尺子。
 */
function scoreCandidate(c: Candidate): number {
  let s = baseScore(c.source);
  if (c.initiator === 'video' || c.initiator === 'audio') s += 20;
  if (c.contentType) s += 12;
  if (c.viaNetwork && c.size) s += 8;
  if (c.duration) s += 6;
  if (c.width && c.height) s += 6;
  if (c.poster) s += 4;
  if (c.title) s += 3;
  if (c.fallbackUrl) s += 3;
  return s;
}

/** 保留高分条目的字段，用低分条目补齐它的空缺 */
function mergeCandidate(a: Candidate, b: Candidate): Candidate {
  const win = b.score > a.score ? b : a;
  const lose = b.score > a.score ? a : b;
  return {
    url: win.url,
    score: win.score,
    title: win.title || lose.title,
    poster: win.poster || lose.poster,
    width: win.width || lose.width,
    height: win.height || lose.height,
    duration: win.duration || lose.duration,
    size: win.size || lose.size,
    source: win.source || lose.source,
    contentType: win.contentType || lose.contentType,
    fallbackUrl: win.fallbackUrl || lose.fallbackUrl,
    headers: { ...(lose.headers || {}), ...(win.headers || {}) },
    viaNetwork: win.viaNetwork ?? lose.viaNetwork,
    initiator: win.initiator || lose.initiator,
    probeOk: win.probeOk ?? lose.probeOk,
    streamKind: win.streamKind || lose.streamKind,
  };
}

/** 同一资源可能被多层同时捞到，按规范化地址去重并合并 */
function dedupe(candidates: Candidate[]): Candidate[] {
  const bucket = new Map<string, Candidate>();
  const order: string[] = [];
  candidates.forEach(item => {
    const key = normalizeForDedupe(item.url);
    const prev = bucket.get(key);
    if (!prev) {
      bucket.set(key, item);
      order.push(key);
      return;
    }
    bucket.set(key, mergeCandidate(prev, item));
  });
  return order.map(key => bucket.get(key)).filter(Boolean) as Candidate[];
}

/** 终审：过不了的直接丢弃，不再占用探测与展示名额 */
function keep(c: Candidate): boolean {
  if (!c.url || !/^https?:/i.test(c.url)) return false;
  if (isJunkUrl(c.url)) return false;
  // 体积已知且过小：占位图 / 广告素材。清单本身很小是正常的，放行
  if (c.size && c.size > 0 && c.size < LIMITS.MIN_VIDEO_SIZE && !isManifestUrl(c.url)) {
    return false;
  }
  return true;
}

function toCandidate(raw: {
  url: string;
  poster?: string;
  w?: number;
  h?: number;
  duration?: number;
  title?: string;
  size?: number;
  source?: string;
  contentType?: string;
  fallbackUrl?: string;
  headers?: Record<string, string>;
  viaNetwork?: boolean;
  initiator?: string;
  probeOk?: boolean;
}): Candidate {
  const candidate: Candidate = {
    url: raw.url,
    poster: raw.poster || undefined,
    width: raw.w || undefined,
    height: raw.h || undefined,
    duration: raw.duration || undefined,
    size: raw.size || undefined,
    source: raw.source,
    contentType: raw.contentType || undefined,
    fallbackUrl: raw.fallbackUrl || undefined,
    headers: raw.headers,
    viaNetwork: raw.viaNetwork,
    initiator: raw.initiator,
    probeOk: raw.probeOk,
    score: 0,
  };
  candidate.score = scoreCandidate(candidate);
  return candidate;
}

function toMediaItem(c: Candidate, index: number): MediaItem {
  const streamKind: VideoStreamKind =
    c.streamKind || classifyStream(c.url, c.contentType);
  return {
    id: `vid-${index}`,
    kind: 'video',
    url: c.url,
    poster: c.poster,
    title: shortTitle(c.title, c.url),
    width: c.width,
    height: c.height,
    duration: c.duration,
    size: c.size,
    source: c.source,
    contentType: c.contentType,
    fallbackUrl: c.fallbackUrl,
    headers: c.headers && Object.keys(c.headers).length ? c.headers : undefined,
    viaNetwork: c.viaNetwork,
    pageProbeOk: c.probeOk,
    streamKind: streamKind === 'unknown' ? undefined : streamKind,
  };
}

function collectImages(payload: RawScrapePayload): MediaItem[] {
  const seen = new Set<string>();
  const images: MediaItem[] = [];
  (payload.images || []).forEach((raw, index) => {
    if (!raw?.url || seen.has(raw.url)) return;
    if (isJunkUrl(raw.url)) return;
    seen.add(raw.url);
    images.push({
      id: `img-${index}`,
      kind: 'image',
      url: raw.url,
      title: shortTitle(raw.title, raw.url),
      width: raw.w || undefined,
      height: raw.h || undefined,
      size: raw.size || undefined,
      source: raw.source,
    });
    if (images.length >= LIMITS.IMAGES) return;
  });
  return images;
}

/** 一条都没抓到时，尽量说清楚「为什么没有」 */
function buildHint(payload: RawScrapePayload, stats: ScrapeStats): string {
  if (stats.mse || stats.blobVideos > 0) {
    // MSE 注册过的 codec 是「页面确实在播视频」的硬证据，说出来比笼统提示更好排查
    const codec = (payload.mseMimes || [])
      .map(value => String(value).replace(/;.*$/, '').trim())
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .join(' / ');
    return codec
      ? `页面通过 MSE 实时合成视频（${codec}），没有可直接下载的地址`
      : '页面中的视频由脚本实时合成（MSE/Blob），没有可直接下载的地址';
  }
  if (stats.streamVideos > 0) {
    return '页面播放的是实时媒体流（WebRTC/MediaStream），没有可下载的文件';
  }
  if (stats.rawVideos > 0 || stats.dropped > 0) {
    return '页面里的视频地址均不可用，多为登录态、防盗链或加密流';
  }
  return '未在该页面发现可下载的图片或视频，换一个网址试试';
}

/**
 * 通用抓取方法：把页面脚本回传的原始结果整合成展示用的媒体列表。
 *
 * 不区分站点，全部走页面脚本那一套规则。
 * 任何一步出错都不会抛出——单条候选异常只是被丢掉，
 * 调用方拿到的永远是可渲染的列表。
 */
export async function scrapeMedia(payload: RawScrapePayload): Promise<ScrapeOutcome> {
  const images = collectImages(payload);

  const rawVideos = Array.isArray(payload.videos) ? payload.videos : [];
  const candidates: Candidate[] = [];
  let dropped = 0;

  rawVideos.forEach(raw => {
    if (!raw?.url) return;
    const candidate = toCandidate(raw);
    if (!keep(candidate)) {
      dropped += 1;
      return;
    }
    candidates.push(candidate);
  });

  const videos = dedupe(candidates)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMITS.VIDEOS)
    .map(toMediaItem);

  const stats: ScrapeStats = {
    mse: !!payload.mse,
    blobVideos: payload.blobVideos || 0,
    streamVideos: payload.streamVideos || 0,
    rawVideos: rawVideos.length,
    dropped,
  };

  const empty = !images.length && !videos.length;
  return {
    images,
    videos,
    hint: empty ? buildHint(payload, stats) : undefined,
    stats,
  };
}
