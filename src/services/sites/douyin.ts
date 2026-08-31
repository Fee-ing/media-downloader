/**
 * 抖音站点适配。
 *
 * 为什么需要适配：
 * 1. 页面是 JS 壳，作品数据来自 /aweme/v1/web/aweme/detail/。DOM 里只有一个 <video>，
 *    码率由播放器选定，用户没法挑清晰度；接口里的 video.bit_rate[] 才有全档位，
 *    还带着精确体积、分辨率、时长、封面与文案。
 * 2. CDN 直链没有文件扩展名（.../?a=6383&...&mime_type=video_mp4），
 *    通用抓取的扩展名规则匹配不到，除正在播的那条外全部漏掉。
 * 3. 页面会加载站点自己的占位视频、头像与登录面板配图，通用抓取会把它们当成可下载资源。
 *
 * 取数方式：在 WebView 里直接用 fetch 请求详情接口。
 * - 实测该接口在页面上下文里不需要 a_bogus 签名，带页面 cookie 即可返回完整数据，
 *   因此不必去抢「脚本早于页面执行」的时序；
 * - 实测 XHR 拿到的是空响应体，只能用 fetch；
 * - 无 cookie 的新 WebView 访问作品页会被 302 到首页/落地页（只渲染出备案信息），
 *   详情接口也会被风控；请求前先预热一次首页拿 ttwid，首次失败后重试；
 * - 请求失败时会保留通用抓取的 DOM/网络结果，不会变成「一条都抓不到」。
 *
 * 实测响应结构（2026-08）：
 *   aweme_detail.desc                 作品文案
 *   aweme_detail.duration             时长（毫秒）
 *   aweme_detail.video.play_addr      最高档无水印直链，url_list 内是多个 CDN 备份
 *   aweme_detail.video.bit_rate[]     各档位：gear_name / bit_rate / play_addr / is_h265 / is_bytevc1
 *   aweme_detail.video.origin_cover   封面
 *   aweme_detail.images[]             图文作品的图片（视频作品为空）
 */

import type { MediaItem } from '../../types';
import type { SiteAdapter, SiteContext } from './types';

/** 主站与分享短链域 */
const DOUYIN_HOST = /(^|\.)(douyin|iesdouyin)\.com$/i;
/** 作品页：/video/{id}、/note/{id}，以及 iesdouyin 的 /share/video/{id} */
const DOUYIN_PATH = /^\/(video|note|share\/video|share\/note)\/(\d{6,})/;

/**
 * 注入到页面里的采集脚本。
 *
 * 主路径是采集阶段主动 fetch 详情接口（与注入时机无关）；
 * 顺带在页面早期挂一个响应钩子，能省掉这次额外请求——钩子没挂上也无所谓。
 */
export const DOUYIN_PAGE_SCRIPT = `(function () {
  if (window.__MD_DY__) { return; }
  var MD = window.__MD__;
  if (!MD) { return; }
  var DY = (window.__MD_DY__ = { raw: '', aweme: null });

  var HOST_RE = /(^|\\.)(douyin|iesdouyin)\\.com$/i;
  var PATH_RE = /^\\/(video|note|share\\/video|share\\/note)\\/(\\d{6,})/;
  var DETAIL_RE = /aweme\\/v1\\/web\\/aweme\\/detail\\//;
  // 前端静态资源域：站点自己的占位视频、logo 与 UI 图标，都不是作品内容
  var STATIC_HOST_RE = /(^|\\.)douyinstatic\\.com$/i;
  var AVATAR_RE = /\\/aweme-avatar\\//i;
  // 登录面板素材
  var PASSPORT_RE = /\\/obj\\/passport-fe\\//i;
  var VOD_RE = /douyinvod\\.com/i;
  // 详情接口自取的超时；超时后沿用通用抓取结果
  var API_TIMEOUT = 8000;

  /**
   * 判定归属要用用户输入的原始地址，而不是当前 location。
   * 抖音触发风控时会跳到 /jingxuan（推荐流），此时 location 已不是作品页，
   * 但用户要抓的仍是那个作品——详情接口只认 aweme_id，与页面停在哪无关。
   */
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
      return HOST_RE.test(u.hostname) && PATH_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  function awemeId() {
    try {
      var m = PATH_RE.exec(new URL(pageHref()).pathname);
      return m ? m[2] : '';
    } catch (e) {
      return '';
    }
  }

  function hostOf(u) {
    try { return new URL(u, location.href).hostname; } catch (e) { return ''; }
  }

  /** 静态素材 / 头像 / 登录面板配图，通用抓取会把它们误当成可下载资源 */
  function isJunk(u) {
    if (!u) { return true; }
    if (STATIC_HOST_RE.test(hostOf(u))) { return true; }
    if (AVATAR_RE.test(u)) { return true; }
    return PASSPORT_RE.test(u);
  }

  function firstUrl(node) {
    var list = node && node.url_list;
    if (!list) { return ''; }
    for (var i = 0; i < list.length; i++) { if (list[i]) { return list[i]; } }
    return '';
  }

  function parseDetail(text) {
    if (!text) { return null; }
    try {
      var json = JSON.parse(text);
      var aweme = json && json.aweme_detail;
      // 没有 video 也没有 images 的通常是错误/风控响应，不能当成作品
      return aweme && (aweme.video || (aweme.images && aweme.images.length)) ? aweme : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 预热：访问一次主站首页，让服务端下发 ttwid 等 cookie。
   *
   * 无 cookie 的新 WebView 访问作品页会被 302 到首页/落地页（只渲染出备案信息），
   * 详情接口也会因为缺 cookie 被风控。先拿 cookie 再请求详情才有完整数据。
   * 取数只依赖响应头里的 Set-Cookie，读到 headers 就关掉 body 流。
   */
  function warmup() {
    if (typeof window.fetch !== 'function') { return Promise.resolve(false); }
    return window.fetch('https://www.douyin.com/', { credentials: 'include' }).then(function (res) {
      try { if (res.body && res.body.cancel) { res.body.cancel(); } } catch (e) {}
      return true;
    }, function () { return false; });
  }

  function hasDouyinCookie() {
    try { return /(^|;\\s*)ttwid=/.test(document.cookie || ''); } catch (e) { return false; }
  }

  /**
   * 取作品详情：钩子已抓到就复用，否则自己请求一次。
   *
   * 该接口在页面上下文里不需要 a_bogus 签名，带上页面 cookie 就能返回完整数据，
   * 所以不依赖「注入脚本早于页面脚本」这一时序，Android 上的注入竞态也不会影响结果。
   * 请求前先预热首页拿 cookie，避免因缺 ttwid 被风控拦截。
   */
  function fetchDetail() {
    if (DY.aweme) { return Promise.resolve(DY.aweme); }
    var id = awemeId();
    if (!id) { return Promise.resolve(null); }
    var query =
      'device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=' + id +
      '&pc_client_type=1&version_code=190600&version_name=19.6.0&cookie_enabled=true&platform=PC&downlink=10';
    function request() {
      return new Promise(function (resolve) {
        var settled = false;
        function done(value) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
        var timer = setTimeout(function () { done(null); }, API_TIMEOUT);
        try {
          if (typeof window.fetch !== 'function') { return done(null); }
          // 必须走 fetch：实测 XHR 拿到的是空响应体。
          // 用绝对地址请求，即使页面被重定向到首页/其它域也能命中正确的接口域。
          window.fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?' + query, {
            headers: { accept: 'application/json, text/plain, */*' },
            credentials: 'include'
          }).then(function (res) {
            if (!res.ok) { return done(null); }
            return res.text().then(function (t) { done(parseDetail(t)); }, function () { done(null); });
          }, function () { done(null); });
        } catch (e) {
          done(null);
        }
      });
    }
    // 已有 cookie 就直接请求，否则先预热拿 cookie；首次失败（风控/缺 cookie）再预热重试一次
    return (hasDouyinCookie() ? Promise.resolve(true) : warmup()).then(request).then(function (aweme) {
      if (aweme) { return aweme; }
      return warmup().then(request);
    });
  }

  /**
   * 可选优化：挂上响应钩子，直接复用页面自己请求到的详情数据，省掉上面那次请求。
   * 只在抖音作品页安装，其它页面完全不受影响；挂不上也不影响主路径。
   */
  function installHooks() {
    function feed(text) {
      if (!text || DY.raw) { return; }
      DY.raw = text;
      DY.aweme = parseDetail(text);
    }

    var originFetch = window.fetch;
    if (typeof originFetch === 'function') {
      window.fetch = function (input) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        var pending = originFetch.apply(this, arguments);
        if (url && DETAIL_RE.test(url)) {
          try {
            pending.then(function (res) {
              try {
                var copy = res.clone();
                copy.text().then(function (t) { feed(t); });
              } catch (err) {}
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
        if (this.__mdUrl && DETAIL_RE.test(this.__mdUrl)) {
          var self = this;
          this.addEventListener('load', function () {
            try { feed(self.responseText || ''); } catch (e) {}
          });
        }
      } catch (e) {}
      return originSend.apply(this, arguments);
    };
  }

  function labelOf(gear, height) {
    var name = gear && gear.gear_name ? String(gear.gear_name) : '';
    var m = /([0-9]{3,4})/.exec(name);
    if (m) { return m[1] + 'P'; }
    return height ? height + 'P' : '';
  }

  /**
   * 挑出可用的清晰度档位。
   *
   * is_h265 / is_bytevc1 是 HEVC 与字节自研编码，原生播放器放不出来，
   * 就算体积更小也一并排除；同分辨率只留码率最高的那档。
   */
  function pickGears(video) {
    var best = {};
    var order = [];
    var gears = video.bit_rate || [];
    for (var i = 0; i < gears.length; i++) {
      var g = gears[i] || {};
      var pa = g.play_addr || {};
      var urls = pa.url_list || [];
      if (!urls.length) { continue; }
      if (g.is_bytevc1 || g.is_h265 || g.HDR_type) { continue; }
      if (g.format && !/^mp4$/i.test(String(g.format))) { continue; }
      var w = pa.width || video.width || 0;
      var h = pa.height || video.height || 0;
      var key = w + 'x' + h;
      var entry = {
        url: urls[0],
        backup: '',
        size: pa.data_size || 0,
        w: w,
        h: h,
        bitRate: g.bit_rate || 0,
        label: labelOf(g, h)
      };
      // url_list 里还有一条 /aweme/v1/play/ 的跳转地址，作为最后兜底
      for (var j = 1; j < urls.length; j++) {
        if (urls[j] && urls[j] !== entry.url) { entry.backup = urls[j]; break; }
      }
      var prev = best[key];
      if (prev && prev.bitRate >= entry.bitRate) { continue; }
      if (!prev) { order.push(key); }
      best[key] = entry;
    }
    var list = [];
    for (var k = 0; k < order.length; k++) { list.push(best[order[k]]); }
    list.sort(function (a, b) { return b.bitRate - a.bitRate; });
    return list;
  }

  function collect(out, api) {
    // 先清掉站点自己的占位素材：详情接口没抓到时也要生效
    out.videos = out.videos.filter(function (v) { return !isJunk(v.url); });
    out.images = out.images.filter(function (im) { return !isJunk(im.url); });

    return fetchDetail().then(function (aweme) {
      // 拿不到详情就保留通用抓取的 DOM/网络结果，不至于一条都出不来
      if (!aweme) { return; }

      var video = aweme.video || {};
      var desc = String(aweme.desc || '').trim();
      var duration = video.duration || aweme.duration || 0;
      var poster = firstUrl(video.origin_cover) || firstUrl(video.cover) || firstUrl(video.dynamic_cover);

      var gears = pickGears(video);
      if (!gears.length) {
        // 少数作品没有 bit_rate 列表，退回 video.play_addr 的单一档位
        var main = video.play_addr;
        if (!main || !main.url_list || !main.url_list.length) { return; }
        gears = [{
          url: main.url_list[0],
          backup: main.url_list[1] || '',
          size: main.data_size || 0,
          w: main.width || video.width || 0,
          h: main.height || video.height || 0,
          bitRate: 0,
          label: labelOf(null, main.height || video.height)
        }];
      }

      // 接口已按清晰度全量给出直链，DOM/网络嗅探到的只是其中一份且缺元数据，去重后丢弃。
      // 通用层新增强的 JSON 扫描会把 play_addr 的 /aweme/v1/play/ 跳转地址也收录进来，
      // 一并清掉，再按接口档位重加（带标题、封面与元数据）。
      api.removeVideosBy(function (u) {
        return VOD_RE.test(u) || /aweme\\/v1\\/play/i.test(u);
      });

      for (var i = 0; i < gears.length; i++) {
        var g = gears[i];
        var title = desc
          ? (g.label ? desc + ' · ' + g.label : desc)
          : (g.label ? '抖音视频 · ' + g.label : '抖音视频');
        api.addVideo({
          url: g.url,
          fallbackUrl: g.backup || undefined,
          poster: poster || undefined,
          w: g.w,
          h: g.h,
          duration: duration ? Math.round(duration / 1000) : undefined,
          size: g.size || undefined,
          title: title,
          source: 'douyin'
        });
      }

      // 图文作品：高清原图只在图集字段里，页面上用的是裁剪过的预览
      var images = aweme.images || aweme.image_list || [];
      for (var n = 0; n < images.length; n++) {
        var img = images[n] || {};
        var url = firstUrl(img);
        if (!url) { continue; }
        api.addImage({
          url: url,
          w: img.width || 0,
          h: img.height || 0,
          title: desc ? desc + ' · 图 ' + (n + 1) : '图 ' + (n + 1),
          source: 'douyin'
        });
      }
    });
  }

  try {
    if (match()) { installHooks(); }
  } catch (e) {}

  MD.sites = MD.sites || [];
  MD.sites.push({
    id: 'douyin',
    match: match,
    collect: collect
  });

  return true;
})();`;

export const douyinAdapter: SiteAdapter = {
  id: 'douyin',
  match(pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      return DOUYIN_HOST.test(parsed.hostname) && DOUYIN_PATH.test(parsed.pathname);
    } catch {
      return false;
    }
  },
  /**
   * 抖音没有可用的 App 侧接口：详情接口依赖页面上下文的 cookie，
   * 直连请求拿不到数据。取直链的工作全部交给 pageScript，
   * 这里返回空数组表示「沿用通用抓取结果即可」，不会中断流程。
   */
  async fetchVideos(_ctx: SiteContext): Promise<MediaItem[]> {
    return [];
  },
  pageScript: DOUYIN_PAGE_SCRIPT,
};
