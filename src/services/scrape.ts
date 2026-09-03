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
import { siteNotices, type SiteDebug } from './sites';
import {
  baseScore,
  classifyStream,
  dirOfUrl,
  isAudioTrackLike,
  isJunkUrl,
  isLikelyMediaCdn,
  isManifestUrl,
  isStrongSegmentUrl,
  mediaResourceFingerprint,
  mediaTrackFingerprint,
  mergeAudioTrackUrls,
  m4sTrackKeyOf,
  normalizeForDedupe,
  segmentKeyOf,
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
  /**
   * 站点适配层的诊断信息（按站点 id 归档），用于定位「清晰度上不去 /
   * 无声 / 只抓到 m4s」这类站点特有问题。
   */
  siteDebug?: Record<string, SiteDebug> | null;
}

export interface ScrapeOutcome {
  images: MediaItem[];
  videos: MediaItem[];
  /** 一条都没抓到时给用户看的解释 */
  hint?: string;
  /** 站点给出的补充提示（登录态、清晰度上限、是否退化到网络层嗅探） */
  notices?: string[];
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
  /** 精确防盗链 Referer（资源来自播放器包裹页时，用包裹页地址而非 vod 页面） */
  referer?: string;
  headers?: Record<string, string>;
  viaNetwork?: boolean;
  /** 请求发起者（video / audio / fetch / xmlhttprequest），来自 Resource Timing */
  initiator?: string;
  probeOk?: boolean;
  streamKind?: VideoStreamKind;
  /** 同组 DASH 轨道数量（>1 表示已合并的多轨资源） */
  trackCount?: number;
  /** 独立音轨地址（DASH 伴音轨） */
  audioTrackUrl?: string;
  /** 全部伴音轨地址（多音轨场景，首条与 audioTrackUrl 一致） */
  audioTrackUrls?: string[];
  /** 同组其余轨道地址（备用码率等），播放失败时按序兜底 */
  variantUrls?: string[];
  /** 站点适配层显式声明的伴音轨（DASH 音轨多为 .m4s，URL 特征判不出来） */
  declaredAudio?: boolean;
  /**
   * 站点适配层声明的「同一视频的多清晰度」分组（如 B 站 = bvid + cid）。
   * 打了标记后：各清晰度保留为独立条目，同档位的 CDN 镜像仍然合并。
   */
  variantGroup?: string;
  /** 站点自己的清晰度档位号（B 站 qn） */
  qualityId?: number;
  /** 人类可读的清晰度标签（1080P60 / 4K …） */
  qualityLabel?: string;
  score: number;
}

/** 像素面积：比较清晰度时用 */
function areaOf(c: { width?: number; height?: number }): number {
  return (c.width || 0) * (c.height || 0);
}

/** 去重字符串数组，保留顺序 */
function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 用 other 的空缺字段补齐 keeper。
 *
 * keeper 的 url / score / variantGroup / qualityId / qualityLabel / declaredAudio
 * 一概不动：这些是「这个条目是什么」的身份信息，从别的候选继承就会张冠李戴
 * （同组里既有视频轨也有伴音轨，一继承 declaredAudio 就会把正片标成只有声音）。
 */
function absorbMissing(keeper: Candidate, other: Candidate): void {
  keeper.title = keeper.title || other.title;
  keeper.poster = keeper.poster || other.poster;
  keeper.width = keeper.width || other.width;
  keeper.height = keeper.height || other.height;
  keeper.duration = keeper.duration || other.duration;
  keeper.size = keeper.size || other.size;
  keeper.source = keeper.source || other.source;
  keeper.contentType = keeper.contentType || other.contentType;
  keeper.fallbackUrl = keeper.fallbackUrl || other.fallbackUrl;
  keeper.headers = { ...(other.headers || {}), ...(keeper.headers || {}) };
  keeper.viaNetwork = keeper.viaNetwork || other.viaNetwork;
  keeper.initiator = keeper.initiator || other.initiator;
  keeper.probeOk = keeper.probeOk || other.probeOk;
  keeper.streamKind = keeper.streamKind || other.streamKind;
  if (!keeper.audioTrackUrl) keeper.audioTrackUrl = other.audioTrackUrl;
  if (!keeper.audioTrackUrls || !keeper.audioTrackUrls.length) {
    keeper.audioTrackUrls = other.audioTrackUrls;
  }
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
  // 已配对伴音轨的候选（DASH 音画分离）略加分，便于在探测 / 列表里领先于
  // 只拿到视频轨的同源候选，保证用户拿到的是「有声 + 可合并」的那条
  if (c.audioTrackUrl) s += 2;
  return s;
}

/** 保留高分条目的字段，用低分条目补齐它的空缺 */
function mergeCandidate(a: Candidate, b: Candidate): Candidate {
  const win = b.score > a.score ? b : a;
  const lose = b.score > a.score ? a : b;
  // 伴音轨：两条各自配到的音轨都留着（去重、胜者的排在前面），
  // 避免「同一资源的不同镜像」合并时把音轨配对丢掉
  const audioUrls = mergeAudioTrackUrls(
    mergeAudioTrackUrls(win.audioTrackUrls, win.audioTrackUrl ? [win.audioTrackUrl] : []),
    mergeAudioTrackUrls(lose.audioTrackUrls, lose.audioTrackUrl ? [lose.audioTrackUrl] : []),
  );
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
    trackCount: win.trackCount || lose.trackCount,
    // declaredAudio 是 URL 自身的属性，取胜者即可，不做 OR 合并
    declaredAudio: win.declaredAudio,
    audioTrackUrls: audioUrls.length ? audioUrls : undefined,
    audioTrackUrl: audioUrls.length ? audioUrls[0] : undefined,
    variantUrls: win.variantUrls || lose.variantUrls,
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

/**
 * 分片收口：把漏进候选的 HLS/DASH 分片剔除。
 *
 * 页面脚本只在「网络层」用 seqKey 识别分片（要求同目录 + 同前缀 + 递增编号），
 * DOM / JSON 数据层捞到的分片、以及 hash 命名的分片都会漏到这里，
 * 而 .ts/.m4s 属于视频扩展名，keep() 不会拦截，于是列表被重复分片挤满。
 *
 * 这里以「清单所在目录」为锚点：
 * 1. 目录下已有清单（m3u8/mpd）时，该目录下的强分片扩展名（ts/m2ts/m4s/m4a/aac）
 *    无论命名模式如何一律丢弃——清单已代表整个流，分片单独列出没有意义；
 * 2. 其余分片扩展名（含 mp4/webm/ogg 等 DASH 分片）走与页面脚本 isSegment
 *    同口径的 seqKey 组识别：有清单目录出现 2 次、无清单目录出现 3 次即认定为分片。
 */
function dropSegments(candidates: Candidate[]): Candidate[] {
  if (!candidates.length) return candidates;

  const manifestDirs = new Set<string>();
  candidates.forEach(c => {
    if (isManifestUrl(c.url)) manifestDirs.add(dirOfUrl(c.url));
  });

  // 与页面脚本一致的 seqKey 分组（保留成员，便于判断编号是否连续）
  const groups = new Map<string, Candidate[]>();
  candidates.forEach(c => {
    const key = segmentKeyOf(c.url);
    if (key) {
      const group = groups.get(key);
      if (group) group.push(c);
      else groups.set(key, [c]);
    }
  });

  return candidates.filter(c => {
    if (isManifestUrl(c.url)) return true; // 清单永远保留
    // 站点适配层已明确声明档位的轨道（B 站 DASH 各清晰度）：编号稀疏
    // （30280 / 30216 / 30064 …），很容易被 seqKey 误判成分片序列而整片丢掉
    if (c.variantGroup) return true;
    const dir = dirOfUrl(c.url);
    // 清单目录下的强分片扩展名：命名再乱也是分片
    if (manifestDirs.has(dir) && isStrongSegmentUrl(c.url)) return false;
    const key = segmentKeyOf(c.url);
    const group = key ? groups.get(key) : undefined;
    const count = group ? group.length : 0;
    // 与页面脚本 isSegment 同口径：有清单目录 count >= 2，否则 count >= 3
    if (manifestDirs.has(dir)) return count < 2;
    // 无清单目录：强分片 count >= 3 时按分片丢弃，但编号稀疏的轨道组
    // （如 B 站 DASH 的 30280/30216/30064）是同一条视频，保留待折叠
    if (isStrongSegmentUrl(c.url) && count >= 3 && isDashTrackGroup(group!)) {
      return true;
    }
    return count < 3;
  });
}

/** 提取文件名末尾的编号（m4s 轨道/分片编号），无编号返回 null */
function trailingNumber(url: string): number | null {
  const plain = url.split('#')[0].split('?')[0];
  const base = (plain.split('/').pop() || '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  const m = /([0-9]{1,7})$/.exec(base);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 同目录 + 同前缀的强分片地址：编号稀疏且数量有限 → DASH 轨道组
 * （如 B 站 30280 / 30216 / 30064：同一视频的不同清晰度/音轨），
 * 而不是顺序分片序列（1/2/3…，数量多且编号连续）。
 */
function isDashTrackGroup(group: Candidate[]): boolean {
  if (group.length > 8) return false;
  const unique = new Set<number>();
  group.forEach(c => {
    const n = trailingNumber(c.url);
    if (n !== null) unique.add(n);
  });
  if (unique.size < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  unique.forEach(n => {
    if (n < min) min = n;
    if (n > max) max = n;
  });
  // 编号有缺口（编号跨度 > 数量）→ 稀疏分布，是轨道组而非连续分片
  return unique.size < max - min + 1;
}

/**
 * DASH 轨道组折叠：同一目录 + 同文件名前缀的 .m4s（如 B 站
 * xxx_nb2-1-30280 / 30064 / 30216）是同一视频的不同清晰度/音轨。
 *
 * 在进探测与列表之前折成一条代表候选，其余轨道地址收进 variantUrls
 * 作为播放兜底，避免几十条 m4s 挤满探测预算（VIDEO_PROBE_MAX）与列表名额。
 *
 * 通用逻辑分不清「同一视频的不同清晰度」与「同一视频的不同 CDN 镜像」，
 * 一律折成一条。站点适配层能分清（它从 playinfo 里读到了每档的宽高与档位号），
 * 打了 variantGroup 的候选交给 collapseSiteVariants 按档位保留，不在这里折叠。
 */
function foldM4sTracks(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const rest: Candidate[] = [];
  candidates.forEach(c => {
    if (c.variantGroup) {
      rest.push(c);
      return;
    }
    const key = m4sTrackKeyOf(c.url);
    if (!key) {
      rest.push(c);
      return;
    }
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  });

  const folded: Candidate[] = [];
  groups.forEach(group => {
    if (group.length < 2) {
      folded.push(...group);
      return;
    }
    // 音频轨判定：站点适配层显式声明 > audio 发起者 > Content-Type audio/*
    // > URL 或路径带 audio / .m4a/.aac。DASH 音轨多为 .m4s，后三条几乎都不成立，
    // declaredAudio 是唯一可靠的信号。
    const looksAudio = (c: Candidate) =>
      !!c.declaredAudio ||
      c.initiator === 'audio' ||
      (c.contentType || '').toLowerCase().indexOf('audio/') === 0 ||
      /(?:^|[/._-])audio(?:[/._-]|$)/i.test(c.url) ||
      /\.(?:m4a|aac)(?:[?#]|$)/i.test(c.url);
    // 组内没有视频轨（纯音频组）不折叠：不能把两条音频并成一条视频
    if (group.every(looksAudio)) {
      folded.push(...group);
      return;
    }
    // 代表必须选视频轨：音轨单独播放没有画面。音频候选大幅降权，防止被选为代表。
    // 选代表以「分辨率（面积）最高」为第一优先级（不同清晰度同属一组，应留最高清），
    // 分辨率相同时再让 score 高者领先；音轨分数扣 1000 保底，绝不会抢代表。
    const keeperScore = (c: Candidate) => {
      const area = (c.width || 0) * (c.height || 0);
      const audioPenalty = looksAudio(c) ? -1e9 : 0;
      return area * 1e6 + (c.score || 0) + audioPenalty;
    };
    let best = group[0];
    for (let i = 1; i < group.length; i++) {
      if (keeperScore(group[i]) > keeperScore(best)) best = group[i];
    }
    // 以 best 为底座，用其余轨道补齐空缺字段（best 的 url/score 保持不变）。
    // 注意：declaredAudio 描述的是「这个 URL 自己是音轨还是视频轨」，
    // **绝不能**从同组其它轨道继承 —— 同组里既有视频轨也有伴音轨，一继承就会把
    // 视频轨代表标成音轨，正片随后被当成「只有声音」的条目处理掉。
    // 同组其它轨道已配好的伴音轨则相反，代表没有时必须继承，否则音画配对丢失。
    const keeper: Candidate = { ...best };
    group.forEach(c => {
      if (c !== best) absorbMissing(keeper, c);
    });
    keeper.trackCount = group.length;
    // 备用轨道只收视频轨：音轨单独播放没有画面，不能进播放兜底链
    keeper.variantUrls = group
      .filter(c => c !== best && !looksAudio(c))
      .map(c => c.url);
    // 伴音轨：组内识别出的音轨 + 各轨道自带的配对（站点适配显式给出、或指纹广播
    // 得到的）合并去重，自带配对排在前。识别不出音轨时绝不能把已有配对清成空数组。
    const audioTracks = group.filter(looksAudio);
    keeper.audioTrackUrls = mergeAudioTrackUrls(
      mergeAudioTrackUrls(
        keeper.audioTrackUrls,
        keeper.audioTrackUrl ? [keeper.audioTrackUrl] : [],
      ),
      audioTracks.map(a => a.url),
    );
    if (keeper.audioTrackUrls.length) keeper.audioTrackUrl = keeper.audioTrackUrls[0];
    folded.push(keeper);
  });

  return [...rest, ...folded];
}

/**
 * 站点声明的多清晰度收口。
 *
 * 通用折叠逻辑会把同一视频的多条轨道压成一条，因为它分不清「不同清晰度」和
 * 「不同 CDN 镜像」。站点适配层分得清：它从 playinfo 里读出了每档的宽高与档位号，
 * 并给每条候选打了 variantGroup + qualityId + qualityLabel。
 *
 * 这里对打了标记的候选换一套规则：
 * 1. 按（分辨率 + 档位号）分桶——同桶就是同一档的不同 CDN 镜像，合并成一条，
 *    用镜像补齐主条目的空缺字段；
 * 2. 桶与桶之间**不合并**——每一档清晰度都作为独立条目保留，用户可自行选择；
 * 3. 组内按分辨率从高到低排序，最高清的排在最前；
 * 4. 同组其它清晰度收进 variantUrls，作为主地址失效时的降级兜底；
 * 5. 伴音轨广播给组内每条视频轨——B 站各档清晰度共用同一批音轨。
 */
function collapseSiteVariants(candidates: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const rest: Candidate[] = [];
  candidates.forEach(c => {
    if (!c.variantGroup) {
      rest.push(c);
      return;
    }
    const list = groups.get(c.variantGroup);
    if (list) list.push(c);
    else groups.set(c.variantGroup, [c]);
  });

  const out: Candidate[] = [...rest];
  groups.forEach(list => {
    const isAudio = (c: Candidate) =>
      isAudioTrackLike({
        url: c.url,
        contentType: c.contentType,
        initiator: c.initiator,
        declaredAudio: c.declaredAudio,
      });
    const audioLike = list.filter(isAudio);
    const videoLike = list.filter(c => !isAudio(c));
    // 组内没有视频轨（纯音频组）原样保留，交给通用逻辑处理
    if (!videoLike.length) {
      out.push(...list);
      return;
    }

    const audioUrls = audioLike.map(a => a.url);
    // 按档位分桶：同桶 = 同一清晰度的不同 CDN 镜像
    const buckets = new Map<string, Candidate[]>();
    videoLike.forEach(c => {
      const key = `${c.width || 0}x${c.height || 0}|${c.qualityId || 0}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(c);
      else buckets.set(key, [c]);
    });

    const keepers: { keeper: Candidate; bucketVariants: string[] }[] = [];
    buckets.forEach(bucket => {
      let best = bucket[0];
      for (let i = 1; i < bucket.length; i++) {
        if (bucket[i].score > best.score) best = bucket[i];
      }
      const keeper: Candidate = { ...best };
      // 桶内其余候选（同一清晰度的不同 CDN 镜像）：既补齐主条目的空缺字段，
      // 又把它们的地址收进 variantUrls —— 主地址失效时可降级到镜像，不丢兜底。
      const bucketVariants: string[] = [];
      bucket.forEach(c => {
        if (c === best) return;
        absorbMissing(keeper, c);
        if (c.url) bucketVariants.push(c.url);
      });
      keeper.trackCount = bucket.length;
      // 伴音轨：本条自带的配对（站点适配层给的）排在前，组内识别到的排在后。
      // 本轮识别出 0 条时绝不能把已有配对清成空数组，否则音画配对丢失。
      keeper.audioTrackUrls = mergeAudioTrackUrls(
        mergeAudioTrackUrls(
          keeper.audioTrackUrls,
          keeper.audioTrackUrl ? [keeper.audioTrackUrl] : [],
        ),
        audioUrls,
      );
      if (keeper.audioTrackUrls.length) keeper.audioTrackUrl = keeper.audioTrackUrls[0];
      keepers.push({ keeper, bucketVariants });
    });

    // 分辨率高的排前面：用户默认看到 / 下载到的就是最高清那一档
    keepers.sort(
      (a, b) =>
        areaOf(b.keeper) - areaOf(a.keeper) ||
        (b.keeper.qualityId || 0) - (a.keeper.qualityId || 0),
    );
    const allUrls = keepers.map(k => k.keeper.url);
    keepers.forEach(({ keeper, bucketVariants }) => {
      // 兜底链 = 同分辨率镜像 + 其它清晰度的地址（主地址失效时按序降级）
      keeper.variantUrls = dedupeStrings([
        ...bucketVariants,
        ...allUrls.filter(u => u !== keeper.url),
      ]);
    });
    keepers.forEach(({ keeper }) => out.push(keeper));
  });

  return out;
}

/**
 * 候选排序：站点声明的多清晰度组内按分辨率降序，其余按置信度降序。
 *
 * 同一视频的几档清晰度，来源与置信度完全相同（都来自 playinfo），按 score 排
 * 会退化成「谁先被 addVideo 谁在前」。组内改按分辨率排，最高清的排第一：
 * 列表默认展示、用户随手一点下载，拿到的都是最清晰的那条。
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.variantGroup && a.variantGroup === b.variantGroup) {
    const diff = areaOf(b) - areaOf(a);
    if (diff !== 0) return diff;
    if ((a.qualityId || 0) !== (b.qualityId || 0)) {
      return (b.qualityId || 0) - (a.qualityId || 0);
    }
  }
  return b.score - a.score;
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
  /** 精确防盗链 Referer（资源来自播放器包裹页时，用包裹页地址而非 vod 页面） */
  referer?: string;
  headers?: Record<string, string>;
  viaNetwork?: boolean;
  initiator?: string;
  probeOk?: boolean;
  audioTrackUrl?: string;
  audioTrackUrls?: string[];
  declaredAudio?: boolean;
  variantGroup?: string;
  qualityId?: number;
  qualityLabel?: string;
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
    referer: raw.referer || undefined,
    headers: raw.headers,
    viaNetwork: raw.viaNetwork,
    initiator: raw.initiator,
    probeOk: raw.probeOk,
    declaredAudio: raw.declaredAudio || undefined,
    audioTrackUrl: raw.audioTrackUrl || undefined,
    audioTrackUrls: Array.isArray(raw.audioTrackUrls) && raw.audioTrackUrls.length > 0
      ? raw.audioTrackUrls
      : (raw.audioTrackUrl ? [raw.audioTrackUrl] : undefined),
    variantGroup: raw.variantGroup || undefined,
    qualityId: raw.qualityId || undefined,
    qualityLabel: raw.qualityLabel || undefined,
    score: 0,
  };
  candidate.score = scoreCandidate(candidate);
  return candidate;
}

function toMediaItem(c: Candidate, index: number): MediaItem {
  let streamKind: VideoStreamKind =
    c.streamKind || classifyStream(c.url, c.contentType);
  // DASH 直链可能不带 .mpd/.m4s 扩展名（各站改版后常见），classifyStream 仅凭 URL
  // 与 Content-Type 无法识别，会被当成 unknown/progressive。这里用资源特征来推断：
  // 只要候选已配对独立音轨（音画分离），即可显式标记为 dash，确保播放器声明
  // contentType='dash'、下载器走合并路径。与具体站点无关。
  if (streamKind === 'unknown' && (c.audioTrackUrl || (Array.isArray(c.audioTrackUrls) && c.audioTrackUrls.length))) {
    streamKind = 'dash';
  }
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
    referer: c.referer,
    headers: c.headers && Object.keys(c.headers).length ? c.headers : undefined,
    viaNetwork: c.viaNetwork,
    pageProbeOk: c.probeOk,
    streamKind: streamKind === 'unknown' ? undefined : streamKind,
    trackCount: c.trackCount,
    audioTrackUrl: c.audioTrackUrl,
    audioTrackUrls: c.audioTrackUrls,
    variantUrls: c.variantUrls,
    declaredAudio: c.declaredAudio,
    variantGroup: c.variantGroup,
    qualityId: c.qualityId,
    qualityLabel: c.qualityLabel,
  };
}

/**
 * 给候选补上防盗链请求头。许多站点的直链（m4s/m4a/分片/无扩展名直链）必须带
 * `Referer`（页面地址）甚至 `Origin` 才能下载 / 播放，否则返回 403。
 *
 * 通用规则（与具体站点无关）：
 * - 候选 URL 与页面**同源** → 带 Referer + Cookie（登录态）；
 * - 候选 URL 跨站但落在**常见视频 CDN** 上（isLikelyMediaCdn）→ 至少带 Referer +
 *   Origin（页面 origin）+ 桌面 UA。这类直链多为改版后的无扩展名地址，跨源判定
 *   会误把它们当成第三方而丢弃防盗链头，导致 403（播放无声 / 下载失败）。
 * - 其它跨站第三方域名 → 不带任何头，避免把 A 站登录态泄露给无关站点。
 */
function attachAntiLeechHeaders(c: Candidate, payload: RawScrapePayload): Candidate {
  const pageUrl = payload.pageUrl;
  if (!pageUrl) return c;
  let host: string | undefined;
  try { host = new URL(pageUrl).host; } catch { return c; }
  let targetHost: string | undefined;
  let pageOrigin: string | undefined;
  try { pageOrigin = new URL(pageUrl).origin; } catch { pageOrigin = undefined; }
  try { targetHost = new URL(c.url).host; } catch { targetHost = undefined; }
  if (!targetHost) return c;

  const sameHost = targetHost === host;
  const onMediaCdn = isLikelyMediaCdn(c.url);
  if (!sameHost && !onMediaCdn) return c; // 跨站且非视频 CDN 不带 Cookie/头

  const extra: Record<string, string> = {};
  // 同源才带 Cookie，避免把 A 站登录态泄露给跨站 CDN
  if (sameHost && payload.cookie && payload.cookie.trim()) {
    extra['Cookie'] = payload.cookie.trim();
  }
  if (!extra['Referer']) {
    // 优先用提取时记录的精确 Referer（资源来自播放器包裹页 ?url=<m3u8> 时，原生播放器
    // 正是拿包裹页当 Referer 发请求，CDN 才放行；否则退回页面地址兜底）。
    extra['Referer'] = c.referer || pageUrl;
  }
  if (!sameHost) {
    // 跨站直链通常还需 Origin / 桌面 UA 才能放行（B 站、部分 HLS/DASH CDN 均如此）
    if (pageOrigin && !extra['Origin']) extra['Origin'] = pageOrigin;
    if (!extra['User-Agent']) {
      extra['User-Agent'] =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }
  }
  if (!Object.keys(extra).length) return c;
  return { ...c, headers: { ...(c.headers || {}), ...extra } };
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
 * 不区分站点，全部走页面脚本那一套规则；只有「站点适配层显式声明」的
 * 多清晰度分组（variantGroup）会走专门的收口分支，其余一律通用处理。
 * 任何一步出错都不会抛出——单条候选异常只是被丢掉，
 * 调用方拿到的永远是可渲染的列表。
 */
export async function scrapeMedia(payload: RawScrapePayload): Promise<ScrapeOutcome> {
  const images = collectImages(payload);

  const rawVideos = Array.isArray(payload.videos) ? payload.videos : [];
  let dropped = 0;

  // 音画分离轨道的「同资源音轨广播」：许多站点的播放器实际请求的是带签名的边缘
  // 镜像（各站 CDN 子域/节点不同），而页面脚本（DASH 清单 / JSON）里配对好的音轨
  // 地址可能落在另一个 CDN 节点。通用嗅探抓到的是镜像 URL（score 更高、被选中展示），
  // 而音轨地址只配在了「清单原地址」候选上。若不做广播，最终选中的镜像候选会丢掉
  // 音轨配对，表现为「播放无声 + 下载不合并」。
  // 这里用「媒体资源指纹」（忽略 host 与签名参数后的路径前缀）判断两个候选是否同一
  // 资源，把同批里已配对的 audioTrackUrl 广播给同源资源、自身未带音轨的其它候选，与
  // 具体站点无关。
  if (Array.isArray(rawVideos)) {
    // 按资源指纹收集「已配好音轨的代表地址」（保留整组，多音轨才能一并广播）
    const audioByFingerprint = new Map<string, string[]>();
    for (const r of rawVideos) {
      if (!r?.url) continue;
      const picked = Array.isArray(r.audioTrackUrls) && r.audioTrackUrls.length
        ? r.audioTrackUrls
        : r.audioTrackUrl
          ? [r.audioTrackUrl]
          : [];
      if (!picked.length) continue;
      const key = mediaResourceFingerprint(r.url);
      const prev = audioByFingerprint.get(key);
      audioByFingerprint.set(key, mergeAudioTrackUrls(prev, picked));
    }
    if (audioByFingerprint.size > 0) {
      for (const r of rawVideos) {
        if (!r?.url || r.audioTrackUrl) continue;
        const audio = audioByFingerprint.get(mediaResourceFingerprint(r.url));
        if (audio && audio.length) {
          r.audioTrackUrl = audio[0];
          r.audioTrackUrls = audio.slice();
        }
      }
    }
  }

  // 站点适配层声明的伴音轨：网络层抓到的同轨镜像（主机 / 路径前缀不同，轨道编号一致）
  // 也标记为伴音轨，否则它们会被当成视频轨，可能被选成代表条目（只有声音）。
  const declaredAudioKeys = new Set<string>();
  (payload.audioUrls || []).forEach(url => {
    if (url) declaredAudioKeys.add(mediaTrackFingerprint(url));
  });

  const candidates: Candidate[] = [];
  rawVideos.forEach(raw => {
    if (!raw?.url) return;
    const candidate = toCandidate(raw);
    if (!keep(candidate)) {
      dropped += 1;
      return;
    }
    candidates.push(candidate);
  });

  if (declaredAudioKeys.size) {
    candidates.forEach(candidate => {
      if (candidate.declaredAudio) return;
      if (declaredAudioKeys.has(mediaTrackFingerprint(candidate.url))) {
        candidate.declaredAudio = true;
      }
    });
  }

  // 站点声明的分组广播给同资源的其它候选：网络层嗅探到的伴音轨 / CDN 镜像
  // 与站点给出的轨道地址不同源（主机、路径前缀不同），但指纹（去掉 host 与
  // 尾部编号后的路径）一致。广播后它们才与正片同组，音轨才不会被当成独立条目
  // 展示、镜像才不会被当成另一档清晰度。
  const groupByFingerprint = new Map<string, string>();
  candidates.forEach(candidate => {
    if (!candidate.variantGroup) return;
    const key = mediaResourceFingerprint(candidate.url);
    if (!groupByFingerprint.has(key)) groupByFingerprint.set(key, candidate.variantGroup);
  });
  if (groupByFingerprint.size) {
    candidates.forEach(candidate => {
      if (candidate.variantGroup) return;
      const group = groupByFingerprint.get(mediaResourceFingerprint(candidate.url));
      if (group) candidate.variantGroup = group;
    });
  }

  // 分片收口：把页面脚本漏掉的分片（DOM/JSON 来源、hash 命名）剔除，避免列表被重复分片挤满
  const kept = dropSegments(candidates);
  dropped += candidates.length - kept.length;

  // 站点声明的多清晰度按档位收口（各档保留为独立条目，同档镜像合并）
  const collapsed = collapseSiteVariants(kept);
  // 其余 .m4s 走通用轨道组折叠：同一视频的多条轨道压成一条代表，
  // 省下探测预算与列表名额，其余轨道地址作为播放兜底
  const folded = foldM4sTracks(collapsed);

  let videos = dedupe(folded)
    .sort(compareCandidates)
    .slice(0, LIMITS.VIDEOS)
    .map(c => attachAntiLeechHeaders(c, payload))
    .map(toMediaItem);

  // 视频标题统一为「网页标题_后缀」。
  // 站点声明了清晰度时后缀用档位名（标题_1080P60），比序号有用得多——
  // 同一视频的几档清晰度并列时，只有序号根本分不清该下哪一条。
  // 其余场景沿用序号，仅有一个视频时不加后缀。
  const pageTitle = payload.title?.trim();
  if (videos.length > 0) {
    videos = videos.map((v, i) => {
      const base = pageTitle || v.title;
      if (v.qualityLabel) return { ...v, title: `${base}_${v.qualityLabel}` };
      if (videos.length === 1) return { ...v, title: base };
      return { ...v, title: `${base}_${i + 1}` };
    });
  }

  const stats: ScrapeStats = {
    mse: !!payload.mse,
    blobVideos: payload.blobVideos || 0,
    streamVideos: payload.streamVideos || 0,
    rawVideos: rawVideos.length,
    dropped,
    siteDebug: payload.siteDebug || null,
  };

  const empty = !images.length && !videos.length;
  return {
    images,
    videos,
    hint: empty ? buildHint(payload, stats) : undefined,
    notices: siteNotices(payload.siteDebug),
    stats,
  };
}
