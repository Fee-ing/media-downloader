/**
 * 哔哩哔哩站点适配。
 *
 * 为什么需要适配：B 站 Web 端用 MSE 播放 DASH 流，音频与视频是两条彼此独立的 .m4s，
 * <video> 的 src 是 blob:，DOM 与网络层都拿不到「带声音的完整视频」；
 * 页面上唯一像视频的 og:video 又指向 player.bilibili.com/player.html，那只是个 HTML 页面。
 * 只能走官方播放接口换取「音视频合成的单文件直链」。
 *
 * 关键点：播放接口用 fnval=1（MP4）而不是默认的 DASH。DASH 会把音画拆成两条轨，
 * 原生播放器无法同时吃下；MP4 返回的是单文件且 moov 前置，播放与下载都能直接用。
 */

import type { MediaItem } from '../../types';
import { getApiData, toHttps } from './http';
import type { SiteAdapter, SiteContext } from './types';

const BILI_API = 'https://api.bilibili.com';

interface BiliView {
  bvid?: string;
  aid?: number;
  cid?: number;
  title?: string;
  pic?: string;
  duration?: number;
  /** 稿件投稿时的原始分辨率，不等于实际下发的流分辨率 */
  dimension?: { width?: number; height?: number };
  pages?: Array<{ cid: number; page: number; part?: string }>;
}

interface BiliDashVideo {
  id: number;
  width?: number;
  height?: number;
  codecs?: string;
}

interface BiliPlayUrl {
  timelength?: number;
  dash?: { video?: BiliDashVideo[] };
  durl?: Array<{ url: string; size?: number; backup_url?: string[] }>;
}

function isBilibiliHost(hostname: string): boolean {
  return /(^|\.)bilibili\.(com|tv)$/i.test(hostname);
}

/** 从页面地址里提取 `bvid=xxx` / `aid=xxx` 形式的稿件标识 */
function idQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    const bvid = parsed.searchParams.get('bvid');
    if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) return `bvid=${bvid}`;
    const aid = parsed.searchParams.get('aid');
    if (aid && /^\d+$/.test(aid)) return `aid=${aid}`;
    const inPath = /\/video\/(BV[0-9A-Za-z]{10}|av(\d+))/i.exec(parsed.pathname);
    if (!inPath) return null;
    return inPath[2] ? `aid=${inPath[2]}` : `bvid=${inPath[1]}`;
  } catch {
    return null;
  }
}

/** 分 P 序号，从 1 开始 */
function pageIndex(url: string): number {
  try {
    const value = parseInt(new URL(url).searchParams.get('p') || '1', 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

/** qn=116 只是「期望清晰度」，未登录或稿件没有该清晰度时接口会自动降级 */
function playUrlApi(query: string, cid: number, fnval: number): string {
  return `${BILI_API}/x/player/playurl?${query}&cid=${cid}&qn=116&fnval=${fnval}&fnver=0&fourk=1&otype=json`;
}

/**
 * 取 DASH 列表中最高清晰度的实际宽高。
 *
 * 注意不能直接用 view.dimension（投稿维度）：未登录时接口会降级清晰度，
 * 拿投稿维度显示 1080P、实际流只有 480P 属于明显误导，宁可不显示。
 */
function pickResolution(play?: BiliPlayUrl | null): {
  width?: number;
  height?: number;
} {
  let best: BiliDashVideo | undefined;
  for (const item of play?.dash?.video || []) {
    if (!item.width || !item.height) continue;
    if (!best || item.height > (best.height ?? 0)) best = item;
  }
  return best ? { width: best.width, height: best.height } : {};
}

async function fetchVideos(ctx: SiteContext): Promise<MediaItem[]> {
  const query = idQuery(ctx.pageUrl);
  if (!query) return [];

  const view = await getApiData<BiliView>(
    `${BILI_API}/x/web-interface/view?${query}`,
    ctx.pageUrl,
    ctx.cookie,
  );
  if (!view) return [];

  const index = pageIndex(ctx.pageUrl);
  const pages = view.pages || [];
  const current = pages.filter(item => item.page === index)[0];
  const cid = current ? current.cid : view.cid;
  if (!cid) return [];

  // fnval=1 给音视频合成的 MP4 直链，fnval=16 的 DASH 列表只用来查实际分辨率，
  // 两者并行发出；元数据那一路失败也无所谓，只是不显示分辨率。
  const [play, meta] = await Promise.all([
    getApiData<BiliPlayUrl>(playUrlApi(query, cid, 1), ctx.pageUrl, ctx.cookie),
    getApiData<BiliPlayUrl>(playUrlApi(query, cid, 16), ctx.pageUrl, ctx.cookie),
  ]);

  const stream = play?.durl?.[0];
  if (!stream?.url) return [];

  // 主地址常是 MCDN 节点（形如 xxx.edge.mountaintoys.cn:4483），
  // 备用地址是标准的 upos-sz-*.bilivideo.com，主地址连不上时用它兜底重试。
  const backup = (stream.backup_url || []).filter(
    item => !!item && item !== stream.url,
  )[0];

  const { width, height } = pickResolution(meta) ?? pickResolution(play);
  const durationMs = play?.timelength;
  const title =
    current && pages.length > 1 && current.part
      ? `${view.title} P${index} ${current.part}`
      : view.title;

  return [
    {
      id: `bili-${view.bvid || view.aid}-${cid}`,
      kind: 'video',
      url: stream.url,
      fallbackUrl: backup,
      title: title || '哔哩哔哩视频',
      poster: toHttps(view.pic),
      width,
      height,
      duration: durationMs
        ? Math.round(durationMs / 1000)
        : view.duration || undefined,
      size: stream.size || undefined,
      source: 'bilibili',
    },
  ];
}

/**
 * 注入到页面里的采集脚本。
 *
 * App 侧直连播放接口（上面的 fetchVideos）拿不到数据时（wbi 签名 / 风控），
 * 页面播放器自己请求的 playurl 响应是新鲜的、带正确签名的。这里：
 * 1. 钩住 /x/player/(wbi/)?playurl 响应，解析出 durl（MP4 单文件）或 DASH 直链；
 * 2. 页面内嵌的 window.__playinfo__（B 站播放页 HTML 自带）作为兜底；
 * 3. collect 时把通用层扫到的本站 CDN 裸条目换成精选档位（带标题与 Referer）。
 */
export const BILI_PAGE_SCRIPT = `(function () {
  if (window.__MD_BILI__) { return; }
  var MD = window.__MD__;
  if (!MD) { return; }
  var BL = (window.__MD_BILI__ = { play: null });

  var HOST_RE = /(^|\\.)bilibili\\.(com|tv)$/i;
  var VIDEO_PATH_RE = /^\\/video\\/(BV[0-9A-Za-z]{10}|av\\d+)/i;
  var PLAYURL_RE = /\\/x\\/player\\/(wbi\\/)?playurl/;
  // B 站 DASH/CDN 域：upos-*.bilivideo.com、MCDN（mountaintoys）
  var BILI_CDN_RE = /bilivideo\\.com|mountaintoys\\.cn|mcdn\\.bilivideo\\.cn/i;

  function pageHref() {
    try {
      return (MD.pageHref && MD.pageHref()) || window.__MD_TASK_URL__ || location.href;
    } catch (e) {
      return '';
    }
  }

  function match() {
    try {
      var u = new URL(pageHref());
      return HOST_RE.test(u.hostname) && VIDEO_PATH_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function parsePlay(text) {
    if (!text) { return null; }
    try {
      var json = JSON.parse(text);
      var data = json && json.data;
      if (!data) { return null; }
      if (!data.durl && !(data.dash && data.dash.video && data.dash.video.length)) { return null; }
      return data;
    } catch (e) {
      return null;
    }
  }

  function installHooks() {
    var originFetch = window.fetch;
    if (typeof originFetch === 'function') {
      window.fetch = function (input) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        var pending = originFetch.apply(this, arguments);
        if (url && PLAYURL_RE.test(url)) {
          try {
            pending.then(function (res) {
              try {
                var copy = res.clone();
                copy.text().then(function (t) { if (!BL.play) { BL.play = parsePlay(t); } });
              } catch (e) {}
              return res;
            });
          } catch (e) {}
        }
        return pending;
      };
    }

    var originOpen = XMLHttpRequest.prototype.open;
    var originSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__mdUrl = String(url || ''); } catch (e) {}
      return originOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (this.__mdUrl && PLAYURL_RE.test(this.__mdUrl)) {
          var self = this;
          this.addEventListener('load', function () {
            try { if (!BL.play) { BL.play = parsePlay(self.responseText || ''); } } catch (e) {}
          });
        }
      } catch (e) {}
      return originSend.apply(this, arguments);
    };
  }

  /** 页面内嵌数据兜底：window.__playinfo__ 在播放器就绪后才有 */
  function playinfoData() {
    try {
      var p = window.__playinfo__;
      if (!p) { return null; }
      if (p.data && (p.data.durl || (p.data.dash && p.data.dash.video))) { return p.data; }
      if (p.durl || (p.dash && p.dash.video)) { return p; }
    } catch (e) {}
    return null;
  }

  function streamData() {
    return BL.play || playinfoData();
  }

  function pageMeta() {
    var title = '';
    var poster = '';
    try {
      var t = document.title || '';
      title = t.replace(/[_\\-|]?\\s*哔哩哔哩.*$/i, '').trim();
    } catch (e) {}
    try {
      var og = document.querySelector('meta[property="og:image"]');
      poster = og ? (og.getAttribute('content') || '') : '';
    } catch (e) {}
    return { title: title, poster: poster };
  }

  function collect(out, api) {
    var d = streamData();
    // 页面数据拿不到时保留通用层扫到的直链（可能是可下载的 m4s），不做替换
    if (!d) { return; }

    // 清掉通用层扫到的本站 CDN 裸条目（无标题、DASH 全档位冗余），换成精选档位
    api.removeVideosBy(function (u) { return BILI_CDN_RE.test(u); });
    var meta = pageMeta();
    var base = meta.title || '哔哩哔哩视频';

    // 1) MP4 单文件（fnval=1 的 durl 结构）：一条完整音画
    if (d.durl && d.durl.length) {
      var first = d.durl[0] || {};
      var url = first.url || '';
      if (!url) { return; }
      var fb = '';
      var backups = first.backup_url || [];
      for (var bi = 0; bi < backups.length; bi++) {
        if (backups[bi] && backups[bi] !== url) { fb = backups[bi]; break; }
      }
      api.addVideo({
        url: url,
        fallbackUrl: fb || undefined,
        w: 0,
        h: 0,
        size: first.size || 0,
        duration: d.timelength ? Math.round(d.timelength / 1000) : 0,
        title: base,
        poster: meta.poster || undefined,
        source: 'bilibili',
        headers: { Referer: 'https://www.bilibili.com' }
      });
      return;
    }

    // 2) DASH：视频轨 + 音频轨各选最高档（MSE 页面拿不到合成文件时的兜底）
    var dash = d.dash || {};
    var vBest = null;
    var vList = dash.video || [];
    for (var vi = 0; vi < vList.length; vi++) {
      var v = vList[vi] || {};
      if (!v.baseUrl) { continue; }
      if (!vBest || (v.height || 0) > (vBest.height || 0)) { vBest = v; }
    }
    var aBest = null;
    var aList = dash.audio || [];
    for (var ai = 0; ai < aList.length; ai++) {
      var a = aList[ai] || {};
      if (!a.baseUrl) { continue; }
      if (!aBest || (a.bandwidth || 0) > (aBest.bandwidth || 0)) { aBest = a; }
    }
    var dur = d.timelength ? Math.round(d.timelength / 1000) : 0;
    if (vBest && vBest.baseUrl) {
      api.addVideo({
        url: vBest.baseUrl,
        w: vBest.width || 0,
        h: vBest.height || 0,
        duration: dur || undefined,
        title: base + ' · 视频轨',
        poster: meta.poster || undefined,
        source: 'bilibili',
        headers: { Referer: 'https://www.bilibili.com' }
      });
    }
    if (aBest && aBest.baseUrl) {
      api.addVideo({
        url: aBest.baseUrl,
        w: 0,
        h: 0,
        duration: dur || undefined,
        title: base + ' · 音频轨',
        source: 'bilibili',
        headers: { Referer: 'https://www.bilibili.com' }
      });
    }
  }

  try {
    if (match()) { installHooks(); }
  } catch (e) {}

  MD.sites = MD.sites || [];
  MD.sites.push({
    id: 'bilibili',
    match: match,
    collect: collect
  });

  return true;
})();`;

export const bilibiliAdapter: SiteAdapter = {
  id: 'bilibili',
  match(pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      if (!isBilibiliHost(parsed.hostname)) return false;
      if (parsed.searchParams.get('bvid') || parsed.searchParams.get('aid')) {
        return true;
      }
      // 只认普通稿件页。番剧/影视（bangumi/play/ssNNN）走的是另一套播放接口，
      // 命中了却抓不到反而会掩盖问题，暂不纳入。
      return /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  },
  fetchVideos,
  pageScript: BILI_PAGE_SCRIPT,
};
