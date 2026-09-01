import type { VideoStreamKind } from '../types';

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
  junkHost: compile(PAGE_RULES.junkHost),
  junkPath: compile(PAGE_RULES.junkPath),
  junkAsset: compile(PAGE_RULES.junkAsset),
};

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
