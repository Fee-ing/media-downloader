import type { MediaItem, VideoStreamKind } from '../types';

/**
 * 视频资源判定的共享规则。
 *
 * 判定横跨两端，必须共用同一份口径：
 * 1. 页面脚本（WebView 内）：跨源 no-cors 请求读不到响应头，只能按
 *    「URL 特征 + 请求发起者 initiatorType」粗筛；
 * 2. RN 侧：探测时才拿到真实 Content-Type / Content-Length，做终判与过滤。
 *
 * 因此规则同时以「TS 常量」与「注入到页面脚本的规则串」两种形式存在：
 * PAGE_RULES 会被序列化进注入脚本，避免两处正则各自漂移。
 *
 * 设计上对应 FetchV 扩展的 A3（黑名单）→ A5（MIME 推断）→ A7（格式映射）→
 * A9（终审入库）四道筛子，只是把「响应头」换成了「URL + initiator」的等价证据。
 */

/** 视频 / 流媒体容器扩展名（含清单与分片） */
export const VIDEO_EXTS = [
  'm3u8', 'm3u', 'mpd', 'mp4', 'm4v', 'm4s', 'mov', 'webm', 'mkv', 'avi',
  'ogv', 'ogg', 'flv', 'wmv', 'asf', '3gp', '3gp2', 'f4v', 'ts', 'm2ts',
  'mpg', 'mpeg', 'rmvb',
];

/** 纯音频容器扩展名（视频伴音轨 / 播客） */
export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'oga', 'flac', 'opus', 'wma', 'amr'];

/** 图片扩展名：用于排除误判 */
export const IMAGE_EXTS = [
  'jpe?g', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'jfif',
];

/** 静态资源扩展名：不可能承载视频 */
export const STATIC_EXTS = ['css', 'js', 'mjs', 'woff2?', 'ttf', 'otf', 'eot', 'map', 'wasm'];

const extSrc = (list: string[]) => `\\.(${list.join('|')})(?:[?#]|$)`;

/**
 * 注入到页面脚本的规则集。
 * 只允许出现字符串 / 数字 / 纯对象，因为整个对象会被 JSON 序列化后拼进脚本。
 */
export const PAGE_RULES = {
  videoExt: extSrc(VIDEO_EXTS),
  audioExt: extSrc(AUDIO_EXTS),
  imageExt: extSrc(IMAGE_EXTS),
  staticExt: extSrc(STATIC_EXTS),
  /** 清单（HLS/DASH）：永远保留，它的分片会被丢弃 */
  manifestExt: `\\.(?:m3u8|m3u|mpd)(?:[?#]|$)`,
  /** 分片容器：只有在确认是分片时才丢弃 */
  segmentExt: `\\.(?:ts|m4s|mp4|m4a|aac|webm|ogg)(?:[?#]|$)`,
  /** URL 参数里声明媒体类型：`?mime_type=video_mp4`、`?mime=video/mp4` */
  mimeHint: `[?&](?:mime|mime_?type|mimetype|media_?type|file_?type|type|format|container)=["']?(?:video|audio)[/_-]?[a-z0-9._-]*`,
  /** 广告 / 统计 / 监控域：即使看着像视频也不收录 */
  junkHost: `(^|\\.)(doubleclick|googleadservices|googlesyndication|google-analytics|googletagmanager|googletagservices|adnxs|adsrvr|adservice|adsystem|amazon-adsystem|pubmatic|criteo|taboola|outbrain|scorecardresearch|quantserve|hotjar|sentry|bugsnag|newrelic|datadog|segment|mixpanel|amplitude|clarity|fullstory|smartlook|adform|admaster|miaozhen|adsafeprotected|moatads|imasdk|adcolony|vungle|applovin|ironsource|unity3d)\\.[a-z]{2,}`,
  /** 明显的非内容路径；仅在 URL 无媒体扩展名时生效，避免误杀真实视频 */
  junkPath: `(?:^|[/?])(?:ads?|advert|advertis(?:e|ing)|analytics|track(?:ing|er)?|stat(?:s|istics)?|pixel|beacon|telemetry|logger?|metrics?|monitor|heartbeat|report)(?:[/?._-]|$)`,
  /** 站点占位素材 */
  junkAsset: `(?:sprite|placeholder|loading\\.gif|blank\\.(?:png|gif)|1x1|pixel\\.(?:png|gif)|spacer|icon-|default-avatar|no-?image)`,
  /** 可能返回播放地址的数据接口 */
  dataApi: `\\/(?:api|ajax|graphql|rest|player|playurl|play|vod|media|stream|video|detail|feed|discovery|item|note|view|recommend|search|aweme|sns\\/web|x\\/player)(?:\\/|\\?|$)`,
  /** JSON 里强语义的播放地址键名 */
  videoKeyStrong: `(?:masterUrl|master_url|playUrl|play_url|playAddr|play_addr|playLink|play_link|videoUrl|video_url|srcUrl|src_url|streamUrl|stream_url|mediaUrl|media_url|downloadUrl|download_url|fileUrl|file_url|hlsUrl|hls_url|dashUrl|dash_url|originVideoKey|url_list|urlList|backupUrl|backup_url|backupUrls|backup_urls|baseUrl|base_url)`,
  /** 弱语义键名（`url` / `link` 之类），需要 URL 本身另有媒体特征才采信 */
  videoKeyWeak: `^(?:url|urls|link|uri|src|href|file|path|address)$`,
  /** 常见视频 CDN 域名特征 */
  mediaHost: `(^|\\.)(?:googlevideo|youtube|bilivideo|douyinvod|amemv|aweme|snssdk|iesdouyin|xiaohongshu|xhscdn|kuaishou|ksyun|ks-cdn|gslb|upos|hwcdn|wscdns|aliyun|aliyuncs|myqcloud|qiniu|qbox|byteimg|bytecdn|tiktokcdn|tiktokv|vimeo|dailymotion|twitch|huya|douyu|iqiyi|youku|mgtv|qqlive|sohu|pptv|acfun|cdn|vod|video|videos|media|stream|m3u8|hls)\\.[a-z]{2,}`,
  /** URL 路径里的媒体特征（无扩展名的 CDN 直链全靠它） */
  pathEvidence: `\\/(?:video|videos|vod|vods|media|stream|streams|movie|movies|mp4|hls|dash|m3u8|play|player|playlist|upload|uploads|file|files|attach|attachment|asset|assets|clip|clips|shorts|watch|live|recording)s?(?:\\/|\\.|-|_|\\?|$)`,
  /** 各来源的基础置信度，页面脚本与 RN 侧共用（排序与截断都依赖它） */
  weights: {
    video: 92,
    source: 88,
    embed: 82,
    preload: 78,
    meta: 76,
    'ld+json': 74,
    network: 64,
    json: 56,
    link: 38,
    background: 8,
  },
} as const;

// ============================================================
// RN 侧判定
// ============================================================

function compile(source: string): RegExp {
  try {
    return new RegExp(source, 'i');
  } catch {
    return /(?!)/;
  }
}

const RE = {
  videoExt: compile(PAGE_RULES.videoExt),
  audioExt: compile(PAGE_RULES.audioExt),
  imageExt: compile(PAGE_RULES.imageExt),
  staticExt: compile(PAGE_RULES.staticExt),
  manifestExt: compile(PAGE_RULES.manifestExt),
  segmentExt: compile(PAGE_RULES.segmentExt),
  junkHost: compile(PAGE_RULES.junkHost),
  junkPath: compile(PAGE_RULES.junkPath),
  junkAsset: compile(PAGE_RULES.junkAsset),
  mediaHost: compile(PAGE_RULES.mediaHost),
};

/**
 * 强分片扩展名：几乎只作为 HLS/DASH 流分片出现，不会独立承载正片。
 * 目录下已有清单时，这类扩展名的地址无论命名模式如何都按分片丢弃。
 */
const RE_STRONG_SEGMENT = /\.(?:ts|m2ts|m4s|m4a|aac)(?:[?#]|$)/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isVideoExtension(url: string): boolean {
  return RE.videoExt.test(url);
}

export function isAudioExtension(url: string): boolean {
  return RE.audioExt.test(url);
}

export function isManifestUrl(url: string): boolean {
  return RE.manifestExt.test(url);
}

/** URL 是否携带分片容器扩展名（ts/m4s/mp4/m4a/aac/webm/ogg，与页面脚本 segmentExt 同口径） */
export function isSegmentExtUrl(url: string): boolean {
  return RE.segmentExt.test(url);
}

/** URL 是否携带「强分片」扩展名（ts/m2ts/m4s/m4a/aac） */
export function isStrongSegmentUrl(url: string): boolean {
  return RE_STRONG_SEGMENT.test(url);
}

/** URL 所在目录（去掉 query/hash 后最后一个 / 之前的部分，与页面脚本 dirOf 同口径） */
export function dirOfUrl(url: string): string {
  const plain = url.split('#')[0].split('?')[0];
  const index = plain.lastIndexOf('/');
  return index > -1 ? plain.slice(0, index) : plain;
}

/**
 * 分片组特征键：同目录 + 同扩展名 + 同前缀 + 递增数字编号（seg1/seg2/seg3…）。
 * 与页面脚本 extractor.ts 的 seqKey 保持同口径，用于把散落的分片聚成一组。
 */
export function segmentKeyOf(url: string): string | null {
  const plain = url.split('#')[0].split('?')[0];
  const extMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(plain);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  if (!RE.segmentExt.test('.' + ext)) return null;
  const base = (plain.split('/').pop() || '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  const num = /^(.*?)([0-9]{1,7})$/.exec(base);
  return num ? `${dirOfUrl(plain)}|${ext}|${num[1]}` : null;
}

/**
 * DASH 音视频轨道组键：同目录（忽略 host）+ 同文件名前缀（去掉末尾 1~7 位数字编号）。
 *
 * 同一 DASH 流的不同清晰度/码率轨通常共用目录与前缀，只有尾部编号不同
 * （如 B 站 30280 / 30216 / 64 / 32）；不同视频的流 ID 一般就在目录或
 * 前缀里，不会撞到一起。用于「元数据残缺（时长/分辨率未知、体积不同）的
 * m4s/m4a/aac 是否同源」的判定。
 *
 * 刻意忽略 host：视频 CDN 常用多镜像节点，同一条视频的音视频轨会落在
 * 不同子域（如 B 站 upos-sz-mirrorcos / mirror08c），路径与文件名完全一致。
 * 若把 host 计入 key，同一条视频的轨道会被拆散，导致无法折叠。
 */
export function m4sTrackKeyOf(url: string): string | null {
  const plain = url.split('#')[0].split('?')[0];
  const extMatch = /\.([a-zA-Z0-9]{2,5})$/.exec(plain);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  if (ext !== 'm4s' && ext !== 'm4a' && ext !== 'aac') return null;
  const base = (plain.split('/').pop() || '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  const num = /^(.*?)([0-9]{1,7})$/.exec(base);
  // dirOfUrl 含 host；剥离 scheme://host 只保留路径目录，供跨节点分组
  const pathDir = dirOfUrl(plain).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return `${pathDir}|${num ? num[1] : base}`;
}

/**
 * 媒体资源指纹：忽略 CDN 主机名与签名 / 变化型查询参数后，仅保留「路径目录 +
 * 文件名前缀（去掉末尾编号）」。用于判断两个 URL 是否为「同一媒体资源的不同
 * CDN 镜像」（例如 B 站 playinfo 里的 bilivideo.cn baseUrl 与播放器实际请求的
 * mountaintoys.cn 边缘节点、Youtube 的 googlevideo 多节点等）。
 *
 * 这样「音画分离时给一个镜像配对的音轨」就能通用地广播给同批的其它镜像，而不必
 * 为每个站点维护一份 CDN 域名白名单。
 */
export function mediaResourceFingerprint(url: string): string {
  const plain = url.split('#')[0].split('?')[0];
  // 去掉常见的签名 / 防重放参数（各站命名不一，这里用「长得像乱码的长 token」兜底）
  const pathDir = dirOfUrl(plain).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  const fileBase = (plain.split('/').pop() || '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  // 去掉文件名末尾纯数字编号（同资源不同清晰度/分片编号不同）
  const prefix = fileBase.replace(/[0-9]{1,8}$/, '') || fileBase;
  return `${pathDir}|${prefix}`;
}

/**
 * 候选 URL 是否落在常见视频 CDN 上（与具体站点无关）。用于防盗链头决策：
 * 跨站但命中视频 CDN 的直链通常仍需带 Referer 才能放行，而普通第三方域名则不带。
 */
export function isLikelyMediaCdn(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return RE.mediaHost.test(h);
}

/** 是否为伴音轨：探测后的 Content-Type 最可靠，其次 URL 与发起者特征 */
export function isAudioTrackLike(item: {
  contentType?: string;
  initiator?: string;
  url: string;
}): boolean {
  const ct = (item.contentType || '').toLowerCase();
  if (ct.indexOf('audio/') === 0) return true;
  if (item.initiator === 'audio') return true;
  if (/(?:^|[/._-])audio(?:[/._-]|$)/i.test(item.url)) return true;
  return /\.(?:m4a|aac)(?:[?#]|$)/i.test(item.url);
}

/**
 * 是否为需要丢弃的噪声地址。
 *
 * 有媒体扩展名的一律不按路径特征误杀——「/ad/xxx.mp4」这种路径也完全可能是正片，
 * 只有广告 / 统计域是硬黑名单。
 */
export function isJunkUrl(url: string): boolean {
  if (!url) return true;
  if (RE.junkAsset.test(url)) return true;
  if (RE.junkHost.test(hostOf(url))) return true;
  if (RE.videoExt.test(url) || RE.audioExt.test(url)) return false;
  if (RE.imageExt.test(url) || RE.staticExt.test(url)) return false;
  return RE.junkPath.test(url);
}

/** 依据 URL 与 Content-Type 判断传输形态 */
export function classifyStream(url: string, contentType?: string): VideoStreamKind {
  const ct = (contentType || '').toLowerCase();
  if (/\.(?:m3u8|m3u)(?:[?#]|$)/i.test(url) || /mpegurl/i.test(ct)) return 'hls';
  if (/\.mpd(?:[?#]|$)/i.test(url) || ct.indexOf('dash+xml') >= 0) return 'dash';
  if (RE.videoExt.test(url) || RE.audioExt.test(url)) return 'progressive';
  if (ct.indexOf('video/') === 0 || ct.indexOf('audio/') === 0) return 'progressive';
  return 'unknown';
}

/**
 * 去重用的规范化地址：去掉 hash 与追踪参数。
 * 只用于「是不是同一条资源」的判定，不作为请求地址（签名参数必须原样保留）。
 */
export function normalizeForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'spm', 'from', 'share_source', 'referer', '_t', 'timestamp',
    ].forEach(key => {
      parsed.searchParams.delete(key);
    });
    let path = parsed.pathname;
    if (path.length > 1 && path.charAt(path.length - 1) === '/') {
      path = path.slice(0, -1);
    }
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}?${parsed.searchParams.toString()}`;
  } catch {
    return url.split('#')[0];
  }
}

/** 来源对应的基础置信度 */
export function baseScore(source?: string): number {
  if (!source) return 50;
  const table = PAGE_RULES.weights as Record<string, number>;
  return table[source] ?? 50;
}

// ============================================================
// 探测完成后的二次去重（按内容特征，而非 URL）
// ============================================================

/** 两条时长能否视为同一段视频：未知时长不拦截，已知则要求相差很小 */
function durationsCompatible(a: number | undefined, b: number | undefined): boolean {
  if (!a || !b) return true;
  const diff = Math.abs(a - b);
  const max = Math.max(a, b);
  return diff <= 5 || diff / max <= 0.03;
}

/** 可播放性权重：合并时优先保留可直接播放的条目 */
function playbackWeight(item: MediaItem): number {
  if (item.playback === 'playable') return 3;
  if (item.playback === 'repaired') return 2;
  return 1;
}

/** 同组内比较：可播放 > 可下载 > 分辨率完整且更大 > 体积更大（正数表示 b 更值得留） */
function compareKeeper(a: MediaItem, b: MediaItem): number {
  const pa = playbackWeight(a);
  const pb = playbackWeight(b);
  if (pa !== pb) return pb - pa;
  if (!!a.downloadable !== !!b.downloadable) return (b.downloadable ? 1 : 0) - (a.downloadable ? 1 : 0);
  const areaA = a.width && a.height ? a.width * a.height : 0;
  const areaB = b.width && b.height ? b.width * b.height : 0;
  if (areaA !== areaB) return areaB - areaA;
  return (b.size || 0) - (a.size || 0);
}

function pickKeeper(group: MediaItem[]): MediaItem {
  let best = group[0];
  for (let i = 1; i < group.length; i++) {
    if (compareKeeper(best, group[i]) < 0) best = group[i];
  }
  return best;
}

/** 用被合并条目的字段补齐主条目的空缺（主条目的 id/url/playback 保持不变） */
function mergeInto(keep: MediaItem, drop: MediaItem): void {
  keep.title = keep.title || drop.title;
  keep.poster = keep.poster || drop.poster;
  keep.size = keep.size || drop.size;
  keep.duration = keep.duration || drop.duration;
  if (!keep.width || !keep.height) {
    keep.width = keep.width || drop.width;
    keep.height = keep.height || drop.height;
  }
  keep.source = keep.source || drop.source;
  keep.format = keep.format || drop.format;
  keep.streamKind = keep.streamKind || drop.streamKind;
  keep.contentType = keep.contentType || drop.contentType;
  keep.fallbackUrl = keep.fallbackUrl || drop.fallbackUrl;
  keep.audioTrackUrl = keep.audioTrackUrl || drop.audioTrackUrl;
  keep.audioTrackUrls = keep.audioTrackUrls || drop.audioTrackUrls;
  keep.downloadable = keep.downloadable || drop.downloadable;
  keep.pageProbeOk = keep.pageProbeOk || drop.pageProbeOk;
  keep.viaNetwork = keep.viaNetwork || drop.viaNetwork;
  if (drop.headers) {
    keep.headers = { ...(drop.headers || {}), ...(keep.headers || {}) };
    if (!Object.keys(keep.headers).length) keep.headers = undefined;
  }
}

/**
 * 探测完成后的二次去重。
 *
 * scrapeMedia 的 URL 去重管不住「不同地址、同一内容」的情况；探测补齐了
 * 真实分辨率 / 时长 / 体积后在这里按内容特征合并：
 *
 * 1. 精确匹配（任何格式）：分辨率 + 体积一致，且时长一致（整十秒容差）或
 *    双方时长均未知（渐进式视频探测不产时长）→ 视为同一视频；
 * 2. .m4s 容错匹配：同目录 + 同文件名前缀的 m4s（DASH 不同清晰度/码率轨），
 *    即使时长未知、分辨率未知、体积不同，播放的也是同一段视频。
 *    整组合并为一条代表条目：伴音轨地址收进 audioTrackUrl，其余轨道地址
 *    收进 variantUrls 作为播放兜底，不再单独展示（避免音轨被标成「无法播放」）。
 *
 * 只删除重复项，不改变剩余条目的相对顺序；被保留的条目会补齐来自其它
 * 条目的空缺字段。返回新数组，条目对象会被原地修改（与 probeVideos 一致）。
 */
export function dedupeProbedVideos(items: MediaItem[]): MediaItem[] {
  const dropped = new Set<MediaItem>();

  // Pass 1：精确匹配
  const exact = new Map<string, MediaItem[]>();
  items.forEach(item => {
    if (item.kind !== 'video') return;
    if (!(item.width && item.height && item.size)) return;
    const durationKey = item.duration ? Math.round(item.duration / 10) : 'unknown';
    const key = `${item.width}x${item.height}|${item.size}|${durationKey}`;
    const group = exact.get(key);
    if (group) group.push(item);
    else exact.set(key, [item]);
  });
  exact.forEach(group => {
    if (group.length < 2) return;
    const keeper = pickKeeper(group);
    group.forEach(item => {
      if (item !== keeper) {
        mergeInto(keeper, item);
        dropped.add(item);
      }
    });
  });

  // Pass 2：.m4s 轨道容错匹配
  const tracks = new Map<string, MediaItem[]>();
  items.forEach(item => {
    if (item.kind !== 'video' || dropped.has(item)) return;
    const key = m4sTrackKeyOf(item.url);
    if (!key) return;
    const group = tracks.get(key);
    if (group) group.push(item);
    else tracks.set(key, [item]);
  });
  tracks.forEach(group => {
    const audio = group.filter(item => isAudioTrackLike(item));
    const videoLike = group.filter(item => !audio.includes(item));
    // 组内没有视频轨（纯音频组）不合并；仅一条视频轨且无伴音轨时也无从合并
    if (!videoLike.length) return;
    if (videoLike.length < 2 && !audio.length) return;
    // 已知时长明显不一致时（同目录同前缀却并非同一视频）不合并
    const compatible = videoLike.every(a => videoLike.every(b => durationsCompatible(a.duration, b.duration)));
    if (!compatible) return;
    // 代表必须从视频轨里挑：音轨单独播放没有画面，不能当主条目
    const keeper = pickKeeper(videoLike);
    const variants = group.filter(item => item !== keeper);
    // 用被合并轨道补齐代表条目的空缺字段（id/url/playback 保持不变）
    variants.forEach(item => mergeInto(keeper, item));
    // 记录轨道组信息：总轨道数 / 伴音轨地址 / 备用轨道地址（播放失败时按序兜底）
    keeper.trackCount = group.length;
    keeper.audioTrackUrls = audio.map(item => item.url);
    const audioTrack = audio[0];
    if (audioTrack) keeper.audioTrackUrl = audioTrack.url;
    keeper.variantUrls = variants
      .filter(item => item !== audioTrack && !isAudioTrackLike(item))
      .map(item => item.url);
    if (group.length > 1) {
      keeper.playbackNote =
        keeper.playbackNote || `已合并 ${group.length} 条 DASH 轨道（含音轨与备用码率）`;
    }
    // 其余轨道（含伴音轨）不再单独展示，避免音轨显示成「无法播放」
    variants.forEach(item => dropped.add(item));
  });

  return items.filter(item => !dropped.has(item));
}
