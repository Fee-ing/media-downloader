/**
 * 注入到 WebView 页面中的采集脚本。
 *
 * 分三步：
 * 1. SHARED_SNIPPET 随页面加载注入，挂载 window.__MD__ 工具集与共用规则；
 * 2. NET_SNIPPET 立刻安装网络层钩子，覆盖页面加载初期的媒体请求；
 * 3. 页面加载完成（或超时兜底）后调用 window.__MD__.extract() 采集并回传。
 *
 * 视频采集按「四层漏斗」组织，所有来源最终都汇进同一个 addVideo：
 *
 *   ① DOM        <video>/<source>/<embed>     —— 最可信，但只有当前在播的那条
 *   ② 结构化数据 JSON-LD / og:video / preload —— 站点主动声明的地址
 *   ③ 网络层     PerformanceObserver/fetch/XHR —— 覆盖懒加载与无扩展名 CDN 直链
 *   ④ 数据层     接口 JSON / 页面内嵌 STATE   —— 只在接口响应体里出现的地址
 *
 * 不区分站点：靠「证据」判定而不是域名白名单。
 * 过去为抖音 / B 站 / 小红书写的专属取数逻辑，本质都是两件对所有站点都成立的事——
 * 「接口响应体里翻直链」与「页面内嵌 STATE 里翻直链」，已由第 ④ 层统一承担。
 *
 * 对应 FetchV 扩展的：网络层用 webRequest 抓 media/xhr/object/other，
 * 拿不准时回问内容脚本（CHECK_VIDEO_SRC / CHECK_TEXT_CONTENT），
 * 这里则是「网络层拿不全就往 DOM 与接口响应体里翻」，思路一致、手段换成页面内钩子。
 *
 * 注意：脚本为纯 ES5 风格，避免老旧 WebView 内核语法报错。
 */

import { PAGE_RULES } from './videoRules';

// ============================================================
// 片段一：共享工具 + 规则 + 候选池
// ============================================================

const SHARED_SNIPPET = `(function () {
  if (window.__MD__) { return; }
  var MD = (window.__MD__ = {});
  /** 与 RN 侧共用的判定规则 */
  MD.RULES = ${JSON.stringify(PAGE_RULES)};

  var R = MD.RULES;
  function rx(src) { try { return new RegExp(src, 'i'); } catch (e) { return /(?!)/; } }
  var RE = {
    videoExt: rx(R.videoExt),
    audioExt: rx(R.audioExt),
    imageExt: rx(R.imageExt),
    staticExt: rx(R.staticExt),
    manifestExt: rx(R.manifestExt),
    segmentExt: rx(R.segmentExt),
    mimeHint: rx(R.mimeHint),
    junkHost: rx(R.junkHost),
    junkPath: rx(R.junkPath),
    junkAsset: rx(R.junkAsset),
    dataApi: rx(R.dataApi),
    videoKeyStrong: rx(R.videoKeyStrong),
    videoKeyWeak: rx(R.videoKeyWeak),
    mediaHost: rx(R.mediaHost),
    pathEvidence: rx(R.pathEvidence)
  };
  MD.RE = RE;

  var LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url', 'data-echo', 'data-image', 'data-href', 'data-fallback-src', 'data-video-src', 'data-mp4'];

  function hostOf(u) {
    try { return new URL(u, location.href).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function abs(u) {
    if (!u) { return ''; }
    u = String(u).trim();
    if (!u) { return ''; }
    if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0 || u.indexOf('javascript:') === 0) { return ''; }
    if (u.indexOf('//') === 0) { u = location.protocol + u; }
    try { return new URL(u, location.href).href; } catch (e) { return ''; }
  }

  function text(el) {
    return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  }

  function bestSrcset(value) {
    if (!value) { return ''; }
    var parts = String(value).split(',');
    var best = '', bestW = -1;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim().split(/\\s+/);
      if (!seg[0]) { continue; }
      var d = 1;
      if (seg.length > 1) {
        var m = /^([0-9.]+)/.exec(seg[1]);
        if (m) { d = parseFloat(m[1]) || 1; }
      }
      if (d >= bestW) { bestW = d; best = seg[0]; }
    }
    return best;
  }

  function attrFrom(el, names) {
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute(names[i]);
      if (v && v.indexOf('data:') !== 0) { return v; }
    }
    return '';
  }

  function nearbyTitle(el) {
    var t = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label') || '';
    if (t && t.trim()) { return t.trim().slice(0, 120); }
    var fig = el.closest ? el.closest('figure') : null;
    if (fig) {
      var cap = fig.querySelector('figcaption');
      if (cap) { return text(cap).slice(0, 120); }
    }
    var img = null;
    if (el.querySelector) { img = el.querySelector('img[alt]'); }
    if (img) { return (img.getAttribute('alt') || '').trim().slice(0, 120); }
    return '';
  }

  function isoDuration(value) {
    if (typeof value === 'number' && isFinite(value)) { return value > 0 ? value : undefined; }
    if (typeof value !== 'string') { return undefined; }
    var m = /^P(?:([0-9]+)D)?T?(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+(?:\\.[0-9]+)?)S)?$/.exec(value.trim().toUpperCase());
    if (!m) { return undefined; }
    var s = 0;
    s += (parseInt(m[1] || '0', 10) || 0) * 86400;
    s += (parseInt(m[2] || '0', 10) || 0) * 3600;
    s += (parseInt(m[3] || '0', 10) || 0) * 60;
    s += parseFloat(m[4] || '0') || 0;
    return s > 0 ? s : undefined;
  }

  /** 从 URL 推断分辨率（宽x高 / w=&h= / 1080p），容器探测前兜底用 */
  function resFromUrl(u) {
    var m, w, h;
    m = /(?:^|[^0-9])([0-9]{3,4})[xX\\u00d7]([0-9]{3,4})(?:[^0-9]|$)/.exec(u);
    if (m) {
      w = parseInt(m[1], 10);
      h = parseInt(m[2], 10);
      if (w >= 300 && w <= 7680 && h >= 300 && h <= 7680) { return { w: w, h: h }; }
    }
    m = /[?&](?:w|width)=([0-9]{3,4})[^&#]*[?&](?:h|height)=([0-9]{3,4})/i.exec(u);
    if (m) {
      w = parseInt(m[1], 10);
      h = parseInt(m[2], 10);
      if (w >= 300 && w <= 7680 && h >= 300 && h <= 7680) { return { w: w, h: h }; }
    }
    m = /(?:^|[^0-9])([0-9]{3,4})p(?:[^0-9]|$)/i.exec(u);
    if (m) {
      h = parseInt(m[1], 10);
      if (h >= 300 && h <= 7680) { return { w: Math.round((h * 16) / 9), h: h }; }
    }
    return null;
  }

  function timingMap() {
    var map = {};
    try {
      var entries = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var s = e.encodedBodySize || e.decodedBodySize || e.transferSize || 0;
        if (e.name && s > 512) { map[e.name] = s; }
      }
    } catch (e) {}
    return map;
  }

  /**
   * 噪声判定。
   *
   * 有媒体扩展名的地址一律不按路径特征误杀：/ad/xxx.mp4 也完全可能是正片，
   * 真正可信的只有广告 / 统计域这类硬黑名单。
   */
  function isJunk(u) {
    if (!u) { return true; }
    if (RE.junkAsset.test(u)) { return true; }
    if (RE.junkHost.test(hostOf(u))) { return true; }
    if (RE.videoExt.test(u) || RE.audioExt.test(u)) { return false; }
    if (RE.imageExt.test(u) || RE.staticExt.test(u)) { return false; }
    return RE.junkPath.test(u);
  }
  MD.isJunk = isJunk;

  /**
   * 候选置信度。
   *
   * 列表有上限、可播放性校验也有并发上限，命中上限时只能保留最可能是正片的那些，
   * 因此每条候选都要带一个分数：来源越可信越高，有元数据 / 有响应头佐证的加分，
   * 分片与噪声减分。
   */
  var WEIGHTS = R.weights || {};
  function scoreOf(o) {
    var s = WEIGHTS[o.source] || 50;
    if (o.contentType) { s += 12; }
    if (o.initiator === 'video' || o.initiator === 'audio') { s += 20; }
    if (o.viaNetwork && o.size > 0) { s += 8; }
    if (o.duration) { s += 6; }
    if (o.w && o.h) { s += 6; }
    if (o.poster) { s += 4; }
    if (o.title) { s += 3; }
    if (o.fallbackUrl) { s += 3; }
    if (o.isSegment) { s -= 40; }
    return s;
  }

  // 后面的片段（网络层、采集）都要复用这些工具，统一挂到 MD 上
  MD.scoreOf = scoreOf;
  MD.hostOf = hostOf;
  MD.abs = abs;
  MD.text = text;
  MD.attrFrom = attrFrom;
  MD.bestSrcset = bestSrcset;
  MD.nearbyTitle = nearbyTitle;
  MD.isoDuration = isoDuration;
  MD.resFromUrl = resFromUrl;
  MD.timingMap = timingMap;

  MD.probeState = function () {
    var total = 0, loaded = 0;
    try {
      var imgs = document.images || [];
      for (var i = 0; i < imgs.length; i++) {
        total++;
        if (imgs[i].complete) { loaded++; }
      }
    } catch (e) {}
    return { ready: document.readyState, imgTotal: total, imgLoaded: loaded };
  };

  /** 模拟滚动，触发懒加载；到底或超时后回到顶部 */
  MD.autoScroll = function (maxMs) {
    return new Promise(function (resolve) {
      var finished = false;
      var step = Math.max(360, Math.round((window.innerHeight || 800) * 0.85));
      var y = 0;
      function done() {
        if (finished) { return; }
        finished = true;
        clearInterval(timer);
        clearTimeout(guard);
        try { window.scrollTo(0, 0); } catch (e) {}
        resolve(true);
      }
      var timer = setInterval(function () {
        var doc = document.documentElement || {};
        var body = document.body || {};
        var total = Math.max(doc.scrollHeight || 0, body.scrollHeight || 0);
        y += step;
        try { window.scrollTo(0, y); } catch (e) {}
        if (y >= total || total <= step) { done(); }
      }, 220);
      var guard = setTimeout(done, maxMs || 2500);
    });
  };

  MD.probeImage = function (url, timeout) {
    return new Promise(function (resolve) {
      var img = new Image();
      var settled = false;
      function finish(v) {
        if (settled) { return; }
        settled = true;
        img.onload = null;
        img.onerror = null;
        clearTimeout(t);
        resolve(v);
      }
      img.onload = function () { finish({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = function () { finish(null); };
      var t = setTimeout(function () { finish(null); }, timeout || 3500);
      img.src = url;
    });
  };

  MD.probeVideo = function (url, timeout) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var settled = false;
      function finish(val) {
        if (settled) { return; }
        settled = true;
        v.onloadedmetadata = null;
        v.onerror = null;
        clearTimeout(t);
        try { v.src = ''; } catch (e) {}
        resolve(val);
      }
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = function () {
        finish({
          duration: v.duration && isFinite(v.duration) ? v.duration : undefined,
          w: v.videoWidth || 0,
          h: v.videoHeight || 0
        });
      };
      v.onerror = function () { finish(null); };
      var t = setTimeout(function () { finish(null); }, timeout || 4500);
      v.src = url;
    });
  };

  /**
   * 生成往指定结果集里追加图片 / 视频的函数。
   * 采集的各层都要走同一套去重与补全逻辑，因此从 collect 的闭包里提出来复用。
   */
  function makeAdder(out, seen, timing) {
    return {
      addImage: function (o) {
        o.url = abs(o.url);
        if (!o.url || seen['i' + o.url] || isJunk(o.url)) { return; }
        seen['i' + o.url] = true;
        o.w = o.w > 0 ? Math.round(o.w) : 0;
        o.h = o.h > 0 ? Math.round(o.h) : 0;
        if (o.w && o.h && o.w < 48 && o.h < 48) { return; }
        if (!o.size) { o.size = timing[o.url]; }
        out.images.push(o);
      },
      addVideo: function (o) {
        o.url = abs(o.url);
        if (!o.url || seen['v' + o.url] || isJunk(o.url)) { return; }
        seen['v' + o.url] = true;
        o.w = o.w > 0 ? Math.round(o.w) : 0;
        o.h = o.h > 0 ? Math.round(o.h) : 0;
        // URL 中明确带清晰度（如 1080x1920 / 1080p）时作为兜底
        if ((!o.w || !o.h) && !o.viaNetwork) {
          var rd = resFromUrl(o.url);
          if (rd) {
            if (!o.w) { o.w = rd.w; }
            if (!o.h) { o.h = rd.h; }
          }
        }
        if (!o.size) { o.size = timing[o.url]; }
        if (!o.score) { o.score = scoreOf(o); }
        out.videos.push(o);
      },
    };
  }

  /** 按结果集缓存追加函数，保证同一轮采集里各阶段共用一份去重表 */
  var adderCache = [];
  MD.adderFor = function (out) {
    for (var i = 0; i < adderCache.length; i++) {
      if (adderCache[i].out === out) { return adderCache[i].adder; }
    }
    var adder = makeAdder(out, {}, timingMap());
    adderCache.push({ out: out, adder: adder });
    return adder;
  };

  /**
   * 可遍历的文档根：主文档 + 同源 iframe + 打开的 Shadow DOM。
   * 视频播放器常被塞进 iframe 或 Web Component，只扫 document 会整片漏掉。
   */
  MD.roots = function () {
    var roots = [document];
    var i;
    try {
      var frames = document.querySelectorAll('iframe');
      var fn = Math.min(frames.length, 5);
      for (i = 0; i < fn; i++) {
        try {
          var d = frames[i].contentDocument;
          if (d && d.querySelector) { roots.push(d); }
        } catch (e) {}
      }
    } catch (e) {}
    try {
      var all = document.querySelectorAll('*');
      var cap = Math.min(all.length, 3000);
      var found = 0;
      for (i = 0; i < cap && found < 10; i++) {
        var sr = null;
        try { sr = all[i].shadowRoot; } catch (e) {}
        if (sr && sr.querySelector) { roots.push(sr); found++; }
      }
    } catch (e) {}
    return roots;
  };

  /** 在所有文档根里查询同一选择器 */
  MD.queryAll = function (selector) {
    var roots = MD.roots();
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      try {
        var list = roots[i].querySelectorAll(selector);
        for (var j = 0; j < list.length; j++) { out.push(list[j]); }
      } catch (e) {}
    }
    return out;
  };

  return true;
})();`;

// ============================================================
// 片段二：网络层嗅探
// ============================================================

const NET_SNIPPET = `(function () {
  var MD = window.__MD__;
  if (!MD) { return; }
  var RE = MD.RE;

  var NET_MAX = 200;
  var PAYLOAD_MAX = 30;
  var PAYLOAD_SIZE_MAX = 800000;

  var NET = (MD.net = {
    entries: [],
    index: {},
    payloads: [],
    /** MediaSource.addSourceBuffer 调用次数（>0 即页面走 MSE） */
    mse: 0,
    mseMimes: [],
    /** 通过 MSE 追加的数据量，用于判断是否真的在合成视频 */
    appendBytes: 0,
    /** createObjectURL 调用次数 */
    blobs: 0,
    /** 被转成 Blob 再喂给 <video> 的媒体字节数 */
    mediaBlobBytes: 0,
    /** video.srcObject（MediaStream，如 WebRTC 直播）次数 */
    streams: 0,
    started: false
  });
  /** 兼容旧命名：早期脚本与站点钩子直接读 MD.payloads */
  MD.payloads = NET.payloads;

  function contentTypeOf(res) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') {
        return String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      }
    } catch (e) {}
    return '';
  }

  function sizeOfRes(res) {
    try {
      if (res && res.headers && typeof res.headers.get === 'function') {
        var cr = res.headers.get('content-range');
        if (cr) {
          var m = /\\/([0-9]+)\\s*$/.exec(cr);
          if (m) { return parseInt(m[1], 10) || 0; }
        }
        var cl = res.headers.get('content-length');
        if (cl) { return parseInt(cl, 10) || 0; }
      }
    } catch (e) {}
    return 0;
  }

  /**
   * 是否算媒体请求。
   *
   * 三条证据，任中其一即可：
   * - initiatorType 是 video / audio（浏览器替 <video> 发的请求，铁证，
   *   无扩展名的 CDN 直链全靠这一条捞出来）；
   * - 响应头 Content-Type 是 video/* / audio/* / HLS / DASH；
   * - URL 自带媒体扩展名，或参数里声明了 mime_type=video_mp4 之类。
   *
   * 注意 application/octet-stream 必须配合扩展名才认，否则任何二进制都会被当成视频。
   */
  function looksLikeMedia(u, contentType, initiator) {
    if (initiator === 'video' || initiator === 'audio') { return true; }
    var ct = String(contentType || '').toLowerCase();
    if (/^(video|audio)\\//.test(ct)) { return true; }
    if (/mpegurl|dash\\+xml/.test(ct)) { return true; }
    if (RE.videoExt.test(u) || RE.audioExt.test(u)) { return true; }
    if (RE.mimeHint.test(u)) { return true; }
    return false;
  }

  /** 记录一条网络请求；同一 URL 的多次记录会合并补全 */
  function netAdd(u, extra) {
    if (!u) { return null; }
    var full = '';
    try { full = new URL(u, location.href).href; } catch (e) { return null; }
    if (!full || full.indexOf('http') !== 0) { return null; }
    if (MD.isJunk(full)) { return null; }
    var key = full.split('#')[0];
    var existing = NET.index[key];
    var k;
    if (existing) {
      // 响应头往往晚于请求到达，后到的信息只用来补空，不覆盖已有值
      for (k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          if (existing[k] === undefined || existing[k] === '' || existing[k] === 0) {
            existing[k] = extra[k];
          }
        }
      }
      return existing;
    }
    if (NET.entries.length >= NET_MAX) { return null; }
    var entry = { url: full, size: 0, contentType: '', initiator: '', viaNetwork: true };
    for (k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k) && k !== 'url') { entry[k] = extra[k]; }
    }
    NET.index[key] = entry;
    NET.entries.push(entry);
    return entry;
  }

  MD.netPush = function (u, extra) {
    var info = extra || {};
    if (!u) { return null; }
    if (!looksLikeMedia(u, info.contentType, info.initiator)) { return null; }
    return netAdd(u, info);
  };

  /**
   * 数据接口的响应体。
   *
   * 直链往往藏在 JSON 响应（playurl / detail / feed）或 HLS 清单文本里，
   * 只记 URL 拿不到。这里保存候选接口的响应体，collect 阶段统一解析
   * （对应 FetchV 的 CHECK_TEXT_CONTENT）。
   */
  MD.pushPayload = function (u, body, contentType) {
    try {
      if (!u || !body) { return; }
      var ct = String(contentType || '').toLowerCase();
      // 二进制响应没有扫描价值，读回来只是白耗内存
      if (ct && (/^(video|audio|image|font)\\//.test(ct) || /octet-stream|zip|pdf|wasm/.test(ct))) { return; }
      if (body.length > PAYLOAD_SIZE_MAX) { return; }
      var full = '';
      try { full = new URL(u, location.href).href; } catch (e) { return; }
      if (!full || full.indexOf('http') !== 0) { return; }
      if (MD.isJunk(full)) { return; }
      var i;
      for (i = 0; i < NET.payloads.length; i++) {
        if (NET.payloads[i].url === full) { return; }
      }
      if (NET.payloads.length >= PAYLOAD_MAX) { return; }
      var head = body.replace(/^\\uFEFF/, '').replace(/^\\s+/, '');
      var type = '';
      var json = null;
      if (head.indexOf('#EXTM3U') === 0) {
        type = 'manifest';
      } else if (head.charAt(0) === '{' || head.charAt(0) === '[') {
        try { json = JSON.parse(body); type = 'json'; } catch (e) { return; }
      }
      if (!type) { return; }
      NET.payloads.push({ url: full, type: type, text: body, json: json });
    } catch (e) {}
  };

  /** 是否值得读响应体：媒体直链与静态资源不必读 */
  function isDataUrl(u, contentType) {
    var full = '';
    try { full = new URL(u, location.href).href; } catch (e) { return false; }
    if (!full || full.indexOf('http') !== 0) { return false; }
    if (MD.isJunk(full)) { return false; }
    if (RE.videoExt.test(full) || RE.audioExt.test(full) || RE.mimeHint.test(full)) { return false; }
    if (RE.imageExt.test(full) || RE.staticExt.test(full)) { return false; }
    var ct = String(contentType || '').toLowerCase();
    if (ct) {
      if (/^(video|audio|image|font)\\//.test(ct) || /octet-stream|zip|pdf|wasm/.test(ct)) { return false; }
      // 只认文本型响应
      if (!(ct.indexOf('text/') === 0 || ct.indexOf('json') >= 0 || ct.indexOf('javascript') >= 0 || ct.indexOf('xml') >= 0)) { return false; }
    }
    return RE.dataApi.test(full);
  }

  MD.startNet = function () {
    if (NET.started) { return; }
    NET.started = true;

    // 1) Resource Timing：覆盖 <video>/XHR/fetch 等各类请求，还能拿到真实体积与 initiatorType
    try {
      if (window.PerformanceObserver) {
        var po = new PerformanceObserver(function (list) {
          var items = [];
          try { items = list.getEntries ? list.getEntries() : []; } catch (e) { return; }
          for (var i = 0; i < items.length; i++) {
            var e = items[i];
            var size = e.encodedBodySize || e.decodedBodySize || e.transferSize || 0;
            MD.netPush(e.name, {
              size: size,
              initiator: e.initiatorType || '',
            });
          }
        });
        po.observe({ entryTypes: ['resource'] });
      }
    } catch (e) {}

    // 2) fetch：顺带读响应头（同源 / CORS 暴露时能拿到 Content-Type 与体积）
    try {
      var originFetch = window.fetch;
      if (typeof originFetch === 'function') {
        window.fetch = function (input) {
          var u = '';
          try { u = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
          var pending = originFetch.apply(this, arguments);
          try {
            if (u && pending && typeof pending.then === 'function') {
              pending.then(function (res) {
                try {
                  if (res) {
                    var finalUrl = res.url || u;
                    var ct = contentTypeOf(res);
                    MD.netPush(finalUrl, {
                      contentType: ct,
                      size: sizeOfRes(res),
                      initiator: 'fetch',
                      method: 'GET'
                    });
                    if (res.ok && isDataUrl(finalUrl, ct)) {
                      var copy = res.clone && res.clone();
                      if (copy && typeof copy.text === 'function') {
                        copy.text().then(function (t) { MD.pushPayload(finalUrl, t, ct); }, function () {});
                      }
                    }
                  }
                } catch (err) {}
                return res;
              }, function () {});
            }
          } catch (err) {}
          return pending;
        };
      }
    } catch (e) {}

    // 3) XMLHttpRequest
    try {
      var XP = XMLHttpRequest.prototype;
      var originOpen = XP.open;
      var originSend = XP.send;
      XP.open = function (method, u) {
        try {
          this.__mdUrl = String(u || '');
          this.__mdMethod = String(method || 'GET').toUpperCase();
        } catch (e) {}
        return originOpen.apply(this, arguments);
      };
      XP.send = function () {
        try {
          var self = this;
          self.addEventListener('loadend', function () {
            try {
              var u = self.__mdUrl || '';
              var ct = '';
              var len = 0;
              try { ct = String(self.getResponseHeader('Content-Type') || '').split(';')[0].trim().toLowerCase(); } catch (e) {}
              try { len = parseInt(self.getResponseHeader('Content-Length') || '0', 10) || 0; } catch (e) {}
              var finalUrl = self.responseURL || u;
              MD.netPush(finalUrl, {
                contentType: ct,
                size: len,
                initiator: 'xmlhttprequest',
                method: self.__mdMethod || 'GET'
              });
              if (isDataUrl(finalUrl, ct)) { MD.pushPayload(finalUrl, self.responseText || '', ct); }
            } catch (e) {}
          });
        } catch (e) {}
        return originSend.apply(this, arguments);
      };
    } catch (e) {}

    // 4) URL.createObjectURL：页面把视频抓成 Blob 再喂给 <video> 时，
    //    真实地址只存在于网络层；这里至少记下「确实有媒体被合成」
    try {
      var originCreate = URL.createObjectURL;
      if (typeof originCreate === 'function') {
        URL.createObjectURL = function (obj) {
          try {
            NET.blobs += 1;
            if (typeof Blob !== 'undefined' && obj instanceof Blob) {
              var type = String(obj.type || '');
              if (/^(video|audio)\\//.test(type)) {
                NET.mediaBlobBytes = (NET.mediaBlobBytes || 0) + (obj.size || 0);
              }
            }
          } catch (e) {}
          return originCreate.apply(URL, arguments);
        };
      }
    } catch (e) {}

    // 5) MSE：页面用 MediaSource 播放时，视频是脚本合成的内存流，没有直链。
    //    记下 codec 与数据量，供 RN 侧给出准确提示。
    try {
      if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
        var originAdd = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime) {
          try {
            NET.mse += 1;
            var m = String(mime || '');
            if (m && NET.mseMimes.indexOf(m) < 0) { NET.mseMimes.push(m); }
          } catch (e) {}
          return originAdd.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
        var originAppend = SourceBuffer.prototype.appendBuffer;
        SourceBuffer.prototype.appendBuffer = function (data) {
          try {
            if (data && data.byteLength) { NET.appendBytes = (NET.appendBytes || 0) + data.byteLength; }
          } catch (e) {}
          return originAppend.apply(this, arguments);
        };
      }
    } catch (e) {}

    // 6) <video>/<audio> 的 src 由 JS 动态赋值时，DOM 快照里可能已经没有地址了
    try {
      var MEP = HTMLMediaElement.prototype;
      var srcDesc = Object.getOwnPropertyDescriptor(MEP, 'src');
      if (srcDesc && srcDesc.set) {
        Object.defineProperty(MEP, 'src', {
          configurable: true,
          get: function () { return srcDesc.get ? srcDesc.get.call(this) : ''; },
          set: function (v) {
            try {
              var tag = this.tagName ? String(this.tagName).toLowerCase() : 'media';
              MD.netPush(v, { initiator: tag === 'audio' ? 'audio' : 'video' });
            } catch (e) {}
            return srcDesc.set.call(this, v);
          }
        });
      }
      var originSetAttr = MEP.setAttribute;
      MEP.setAttribute = function (name, value) {
        try {
          if (name === 'src' && value) {
            var tagName = this.tagName ? String(this.tagName).toLowerCase() : 'media';
            MD.netPush(value, { initiator: tagName === 'audio' ? 'audio' : 'video' });
          }
        } catch (e) {}
        return originSetAttr.apply(this, arguments);
      };
      // srcObject：WebRTC / MediaStream 直播，没有可下载文件
      var soDesc = Object.getOwnPropertyDescriptor(MEP, 'srcObject');
      if (soDesc && soDesc.set) {
        Object.defineProperty(MEP, 'srcObject', {
          configurable: true,
          get: function () { return soDesc.get ? soDesc.get.call(this) : null; },
          set: function (v) {
            try { if (v) { NET.streams += 1; } } catch (e) {}
            return soDesc.set.call(this, v);
          }
        });
      }
    } catch (e) {}
  };

  // 尽早启动：覆盖页面加载初期的媒体请求
  MD.startNet();

  return true;
})();`;

// ============================================================
// 片段三：采集与回传
// ============================================================

const COLLECT_SNIPPET = `(function () {
  var MD = window.__MD__;
  if (!MD) { return; }
  var RE = MD.RE;
  var NET = MD.net;
  var abs = MD.abs;
  var text = MD.text;
  var attrFrom = MD.attrFrom;
  var LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url', 'data-echo', 'data-image', 'data-href', 'data-fallback-src', 'data-video-src', 'data-mp4'];

  function metaContent(selector) {
    try {
      var node = document.querySelector(selector);
      return node ? abs(node.getAttribute('content') || '') : '';
    } catch (e) { return ''; }
  }

  MD.collect = function () {
    var out = {
      title: document.title || '',
      pageUrl: location.href,
      cookie: '',
      /** 页面通过 MSE 播放（blob: 源） */
      mse: NET.mse > 0,
      mseMimes: NET.mseMimes || [],
      /** 使用 blob: 源、拿不到直链的视频数量 */
      blobVideos: 0,
      /** srcObject（MediaStream）视频数量 */
      streamVideos: NET.streams || 0,
      /** 网络层捕获到的媒体请求数 */
      networkCount: NET.entries ? NET.entries.length : 0,
      images: [],
      videos: [],
    };
    try { out.cookie = document.cookie || ''; } catch (e) {}
    var adder = MD.adderFor(out);
    var addImage = adder.addImage;
    var addVideo = adder.addVideo;

    // ---------- 图片 ----------
    var imgs = MD.queryAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var raw = '';
      try { raw = el.currentSrc || el.getAttribute('src') || ''; } catch (e) {}
      if (!raw) {
        var ss = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (ss) { raw = MD.bestSrcset(ss); }
      }
      if (!raw) { raw = attrFrom(el, LAZY_ATTRS); }
      if (!raw) { continue; }
      addImage({
        url: raw,
        w: el.naturalWidth || 0,
        h: el.naturalHeight || 0,
        title: MD.nearbyTitle(el),
        source: 'img'
      });
    }

    var sources = MD.queryAll('picture source[srcset]');
    for (var s = 0; s < sources.length; s++) {
      addImage({
        url: MD.bestSrcset(sources[s].getAttribute('srcset')),
        w: 0,
        h: 0,
        title: MD.nearbyTitle(sources[s].parentElement || sources[s]),
        source: 'picture'
      });
    }

    var links = MD.queryAll('a[href]');
    for (var l = 0; l < links.length; l++) {
      var href = links[l].getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') { continue; }
      var full = abs(href);
      if (!full) { continue; }
      if (RE.imageExt.test(full)) {
        addImage({ url: full, w: 0, h: 0, title: text(links[l]).slice(0, 120), source: 'link' });
      } else if (RE.videoExt.test(full) || RE.audioExt.test(full)) {
        addVideo({ url: full, w: 0, h: 0, title: text(links[l]).slice(0, 120), source: 'link' });
      }
    }

    var nodes = MD.queryAll('*');
    var cap = Math.min(nodes.length, 4000);
    for (var n = 0; n < cap; n++) {
      var node = nodes[n];
      var bi = '';
      try {
        var cs = getComputedStyle(node);
        bi = cs ? (cs.backgroundImage || '') : '';
      } catch (e) { continue; }
      if (!bi || bi.indexOf('url(') === -1) { continue; }
      var m = /url\\(['"]?([^'")]+)['"]?\\)/.exec(bi);
      if (!m) { continue; }
      var rect = node.getBoundingClientRect();
      if (!rect || rect.width < 90 || rect.height < 70) { continue; }
      addImage({
        url: m[1],
        w: rect.width,
        h: rect.height,
        title: node.getAttribute('aria-label') || '',
        source: 'background'
      });
    }

    // ---------- 视频：① DOM ----------
    var vids = MD.queryAll('video');
    for (var vi = 0; vi < vids.length; vi++) {
      var vEl = vids[vi];
      var meta = { w: 0, h: 0, duration: undefined, poster: '', title: '' };
      try {
        meta.w = vEl.videoWidth || 0;
        meta.h = vEl.videoHeight || 0;
        if (vEl.duration && isFinite(vEl.duration) && vEl.duration > 0) { meta.duration = vEl.duration; }
        meta.poster = abs(vEl.getAttribute('poster') || '');
        meta.title = MD.nearbyTitle(vEl);
      } catch (e) {}

      var srcs = [];
      var cur = '';
      try { cur = vEl.currentSrc || vEl.getAttribute('src') || ''; } catch (e) {}
      if (cur) { srcs.push(cur); }
      var vs = [];
      try { vs = vEl.querySelectorAll('source'); } catch (e) {}
      for (var k = 0; k < vs.length; k++) {
        var cand = vs[k].getAttribute('src') || vs[k].getAttribute('data-src') || '';
        if (cand) { srcs.push(cand); }
      }
      var lazy = attrFrom(vEl, LAZY_ATTRS);
      if (lazy) { srcs.push(lazy); }

      var added = 0;
      for (var si = 0; si < srcs.length; si++) {
        var srcRaw = srcs[si];
        if (!srcRaw) { continue; }
        if (srcRaw.indexOf('blob:') === 0) { out.blobVideos += 1; continue; }
        if (srcRaw.indexOf('data:') === 0) { continue; }
        addVideo({
          url: srcRaw,
          poster: meta.poster || undefined,
          // 分辨率 / 时长只属于真正在播的那一条，<source> 候选不继承
          w: si === 0 ? meta.w : 0,
          h: si === 0 ? meta.h : 0,
          duration: si === 0 ? meta.duration : undefined,
          title: meta.title,
          source: si === 0 ? 'video' : 'source',
          initiator: 'video'
        });
        added += 1;
      }
    }

    // <video>/<audio> 之外独立出现的 <source>
    var mediaSources = MD.queryAll('source[src]');
    for (var ms = 0; ms < mediaSources.length; ms++) {
      var msEl = mediaSources[ms];
      // 挂在 <video>/<audio> 下的 <source> 上一轮已经处理过，避免重复计数
      var parentTag = msEl.parentNode && msEl.parentNode.tagName ? String(msEl.parentNode.tagName).toLowerCase() : '';
      if (parentTag === 'video' || parentTag === 'audio') { continue; }
      var srcVal = msEl.getAttribute('src') || '';
      if (!srcVal) { continue; }
      if (srcVal.indexOf('blob:') === 0) { out.blobVideos += 1; continue; }
      if (RE.videoExt.test(srcVal) || RE.audioExt.test(srcVal)) {
        addVideo({ url: srcVal, w: 0, h: 0, title: '', source: 'source' });
      }
    }

    // <embed> / <object>：老播放器与部分视频墙仍在用
    var embeds = MD.queryAll('embed[src], object[data]');
    for (var em = 0; em < embeds.length; em++) {
      var eEl = embeds[em];
      var eSrc = eEl.getAttribute('src') || eEl.getAttribute('data') || '';
      if (!eSrc) { continue; }
      if (RE.videoExt.test(eSrc) || RE.audioExt.test(eSrc)) {
        addVideo({ url: eSrc, w: 0, h: 0, title: eEl.getAttribute('title') || '', source: 'embed' });
      }
    }

    // ---------- 视频：② 结构化数据 ----------
    var ldNodes = MD.queryAll('script[type="application/ld+json"]');
    for (var j = 0; j < ldNodes.length; j++) {
      var data = null;
      try { data = JSON.parse(ldNodes[j].textContent || ''); } catch (e) { data = null; }
      if (!data) { continue; }
      var stack = [data];
      var guardCount = 0;
      while (stack.length && guardCount < 200) {
        guardCount++;
        var curNode = stack.pop();
        if (!curNode || typeof curNode !== 'object') { continue; }
        if (Object.prototype.toString.call(curNode) === '[object Array]') {
          for (var a = 0; a < curNode.length; a++) { stack.push(curNode[a]); }
          continue;
        }
        var type = curNode['@type'] || '';
        var types = Object.prototype.toString.call(type) === '[object Array]' ? type.join(',') : String(type);
        if (/VideoObject/i.test(types) && curNode.contentUrl) {
          addVideo({
            url: curNode.contentUrl,
            poster: curNode.thumbnailUrl
              ? (Object.prototype.toString.call(curNode.thumbnailUrl) === '[object Array]' ? curNode.thumbnailUrl[0] : curNode.thumbnailUrl)
              : undefined,
            w: curNode.width || 0,
            h: curNode.height || 0,
            duration: MD.isoDuration(curNode.duration),
            title: String(curNode.name || curNode.headline || '').slice(0, 120),
            source: 'ld+json'
          });
        } else if (/ImageObject/i.test(types) && curNode.contentUrl) {
          addImage({
            url: curNode.contentUrl,
            w: curNode.width || 0,
            h: curNode.height || 0,
            title: String(curNode.name || curNode.caption || '').slice(0, 120),
            source: 'ld+json'
          });
        }
        for (var key in curNode) {
          if (Object.prototype.hasOwnProperty.call(curNode, key) && typeof curNode[key] === 'object') {
            stack.push(curNode[key]);
          }
        }
      }
    }

    // OpenGraph / Twitter Card
    var ogImage = metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');
    if (ogImage) {
      addImage({ url: ogImage, w: 0, h: 0, title: out.title, source: 'meta' });
    }
    // og:video 经常指向站点的「外链播放器页面」（如 B 站的 player.bilibili.com/player.html），
    // 那是一个 HTML 页面而不是媒体文件，收录进来只会得到一条永远放不出的条目。
    var ogVideoType = (function () {
      try {
        var node = document.querySelector('meta[property="og:video:type"]');
        return node ? String(node.getAttribute('content') || '').toLowerCase() : '';
      } catch (e) { return ''; }
    })();
    var ogVideo = metaContent('meta[property="og:video"]')
      || metaContent('meta[property="og:video:url"]')
      || metaContent('meta[property="og:video:secure_url"]')
      || metaContent('meta[name="twitter:player:stream"]');
    var ogVideoIsPage = !ogVideo
      || ogVideoType.indexOf('text/html') === 0
      || /\\.html?(\\?|#|$)/i.test(ogVideo);
    if (ogVideo && !ogVideoIsPage) {
      addVideo({ url: ogVideo, w: 0, h: 0, title: out.title, source: 'meta' });
    }

    // <link rel="preload" as="video">：站点提前声明的播放地址
    var preloads = MD.queryAll('link[rel="preload"][href]');
    for (var pl = 0; pl < preloads.length; pl++) {
      var as = String(preloads[pl].getAttribute('as') || '').toLowerCase();
      if (as !== 'video' && as !== 'audio') { continue; }
      var pHref = abs(preloads[pl].getAttribute('href') || '');
      if (!pHref) { continue; }
      addVideo({ url: pHref, w: 0, h: 0, title: '', source: 'preload' });
    }

    // ---------- 视频：③ 数据层（接口 JSON / 页面内嵌 STATE） ----------
    var IMG_EXT_RE = RE.imageExt;
    var scanBudget = 8000;

    /**
     * 判定一个字符串值是否像视频地址。
     * - URL 自带媒体扩展名 / 类型参数 → 直接采信；
     * - 键名语义强（playUrl / url_list / masterUrl …）→ 采信；
     * - 键名语义弱（url / link …）→ 需要 URL 另有 CDN 域名或路径特征才采信。
     */
    function isVideoish(u, key) {
      if (!u || u.indexOf('http') !== 0) { return false; }
      if (MD.isJunk(u)) { return false; }
      if (IMG_EXT_RE.test(u) || RE.staticExt.test(u)) { return false; }
      if (RE.videoExt.test(u) || RE.audioExt.test(u)) { return true; }
      if (RE.mimeHint.test(u)) { return true; }
      if (RE.videoKeyStrong.test(key || '')) { return true; }
      if (RE.videoKeyWeak.test(key || '')) {
        return RE.mediaHost.test(MD.hostOf(u)) || RE.pathEvidence.test(u);
      }
      return false;
    }

    var toDim = function (v) {
      if (typeof v === 'number' && isFinite(v)) { return Math.round(v); }
      if (typeof v === 'string') {
        var n = parseFloat(v);
        return isFinite(n) ? Math.round(n) : 0;
      }
      return 0;
    };
    var dimOf = function (o) {
      if (!o || typeof o !== 'object' || Object.prototype.toString.call(o) === '[object Array]') { return null; }
      var W = ['width', 'w', 'videoWidth', 'video_width', 'awemeWidth', 'img_width', 'res_w'];
      var H = ['height', 'h', 'videoHeight', 'video_height', 'awemeHeight', 'img_height', 'res_h'];
      var w = 0, h = 0, i, v;
      for (i = 0; i < W.length; i++) {
        v = toDim(o[W[i]]);
        if (v > 0 && v < 20000) { w = v; break; }
      }
      for (i = 0; i < H.length; i++) {
        v = toDim(o[H[i]]);
        if (v > 0 && v < 20000) { h = v; break; }
      }
      return w && h ? { w: w, h: h } : null;
    };

    /**
     * 遍历 JSON 树找播放地址。
     * 数组元素的键名取自「数组所在属性的名字」——抖音的 play_addr.url_list
     * 就是这种结构，只按元素下标判定会整片漏掉。
     */
    var scanJson = function (obj) {
      if (!obj || typeof obj !== 'object') { return; }
      var stack = [{ o: obj, p: null, k: '' }];
      var visited = 0;
      var key, val, ai;
      while (stack.length && visited < scanBudget) {
        var item = stack.pop();
        visited++;
        var cur = item.o;
        if (!cur || typeof cur !== 'object') { continue; }
        var isArr = Object.prototype.toString.call(cur) === '[object Array]';
        if (isArr) {
          for (ai = 0; ai < cur.length; ai++) {
            if (typeof cur[ai] === 'string' && cur[ai].length > 10) {
              if (isVideoish(cur[ai], item.k)) {
                var d = dimOf(item.p);
                addVideo({
                  url: cur[ai],
                  w: d ? d.w : 0,
                  h: d ? d.h : 0,
                  size: 0,
                  title: '',
                  source: 'json'
                });
              }
            } else if (cur[ai] && typeof cur[ai] === 'object') {
              stack.push({ o: cur[ai], p: item.p, k: '' });
            }
          }
          continue;
        }
        for (key in cur) {
          if (!Object.prototype.hasOwnProperty.call(cur, key)) { continue; }
          val = cur[key];
          if (typeof val === 'string' && val.length > 10) {
            if (isVideoish(val, key)) {
              var dim = dimOf(cur) || dimOf(item.p);
              addVideo({
                url: val,
                w: dim ? dim.w : 0,
                h: dim ? dim.h : 0,
                size: 0,
                title: '',
                source: 'json'
              });
            }
          } else if (val && typeof val === 'object') {
            stack.push({ o: val, p: cur, k: Object.prototype.toString.call(val) === '[object Array]' ? key : '' });
          }
        }
      }
    };

    var pi;
    for (pi = 0; pi < NET.payloads.length; pi++) {
      var pl2 = NET.payloads[pi];
      if (pl2.type === 'manifest') {
        addVideo({ url: pl2.url, w: 0, h: 0, size: 0, title: '', source: 'json' });
      } else if (pl2.type === 'json' && pl2.json) {
        scanJson(pl2.json);
      }
    }

    var extractBalanced = function (str, start) {
      var depth = 0, inStr = false, esc = false, i = start;
      for (; i < str.length; i++) {
        var ch = str.charAt(i);
        if (inStr) {
          if (esc) { esc = false; }
          else if (ch === '\\\\') { esc = true; }
          else if (ch === '"') { inStr = false; }
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') { depth++; }
        else if (ch === '}') { depth--; if (depth === 0) { return str.slice(start, i + 1); } }
      }
      return '';
    };

    var scanInlineScripts = function () {
      var scripts;
      try { scripts = document.querySelectorAll('script'); } catch (e) { return; }
      var SCAN_LIMIT = 10;
      var scanned = 0;
      for (var si2 = 0; si2 < scripts.length && scanned < SCAN_LIMIT; si2++) {
        var node = scripts[si2];
        if (node.src) { continue; }
        var body = node.textContent || '';
        if (!body || body.length > 4000000) { continue; }
        var nodeType = String(node.type || '').toLowerCase();
        if (nodeType === 'application/json') {
          try { scanJson(JSON.parse(body)); scanned++; } catch (e) {}
          continue;
        }
        if (nodeType && nodeType !== 'text/javascript' && nodeType !== 'module' && nodeType !== 'application/javascript') { continue; }
        var re = /window\\.([A-Za-z_$][\\w$]*)\\s*=\\s*(\\{)/g;
        var m;
        while ((m = re.exec(body)) !== null) {
          var keyName = m[1];
          if (!/(INIT|playinfo|NEXT|NUXT|SSR|DATA|STATE|PLAYINFO|VIDEO|CONFIG)/i.test(keyName)) { continue; }
          var jsonText = extractBalanced(body, m.index + m[0].length - 1);
          if (!jsonText || jsonText.length > 2000000) { continue; }
          try { scanJson(JSON.parse(jsonText)); } catch (e) {}
          scanned++;
          if (scanned >= SCAN_LIMIT) { break; }
        }
      }
    };
    scanInlineScripts();

    // ---------- 视频：④ 网络层 ----------
    var netList = NET.entries || [];
    var plainOf = function (u) { return u.split('#')[0].split('?')[0]; };
    var dirOf = function (u) {
      var s = plainOf(u);
      var i2 = s.lastIndexOf('/');
      return i2 > -1 ? s.slice(0, i2) : s;
    };
    var extOf = function (u) {
      var m = /\\.([a-zA-Z0-9]{2,5})$/.exec(plainOf(u));
      return m ? m[1].toLowerCase() : '';
    };
    var isManifest = function (u) { return /^(m3u8|m3u|mpd)$/.test(extOf(u)); };

    // 清单所在目录：该目录下的 ts/m4s 一定是它的分片
    var manifestDirs = {};
    var gi;
    for (gi = 0; gi < netList.length; gi++) {
      if (isManifest(netList[gi].url)) { manifestDirs[dirOf(netList[gi].url)] = true; }
    }
    // 分片特征：同目录 + 同扩展名 + 同前缀 + 递增编号（seg1/seg2/seg3…）
    var seqKey = function (u) {
      var ext = extOf(u);
      if (!RE.segmentExt.test('.' + ext)) { return null; }
      var base = (plainOf(u).split('/').pop() || '').replace(/\\.[a-zA-Z0-9]{2,5}$/, '');
      var m = /^(.*?)([0-9]{1,7})$/.exec(base);
      return m ? dirOf(u) + '|' + ext + '|' + m[1] : null;
    };
    var groups = {};
    for (gi = 0; gi < netList.length; gi++) {
      var gKey = seqKey(netList[gi].url);
      if (gKey) { groups[gKey] = (groups[gKey] || 0) + 1; }
    }
    var isSegment = function (u) {
      var ext = extOf(u);
      var k = seqKey(u);
      var count = k ? (groups[k] || 0) : 0;
      // 目录下已有清单：出现两次就足以认定是分片
      if (manifestDirs[dirOf(u)] && /^(ts|m4s|mp4|m4a|aac|webm)$/.test(ext)) { return count >= 2; }
      return count >= 3;
    };

    for (gi = 0; gi < netList.length; gi++) {
      var ne = netList[gi];
      // 清单永远保留，只有分片会被丢弃
      if (!isManifest(ne.url) && isSegment(ne.url)) { continue; }
      addVideo({
        url: ne.url,
        w: 0,
        h: 0,
        size: ne.size || 0,
        title: '',
        source: 'network',
        viaNetwork: true,
        contentType: ne.contentType || '',
        initiator: ne.initiator || ''
      });
    }

    return out;
  };

  /** 对缺失的宽高/时长做二次探测（带整体超时兜底） */
  MD.enrich = function (res) {
    var imgTargets = [], vidTargets = [], i;
    for (i = 0; i < res.images.length && imgTargets.length < 40; i++) {
      if (!res.images[i].w || !res.images[i].h) { imgTargets.push(res.images[i]); }
    }
    // 先补齐缺元数据的，再试播其余视频：probeOk 用于判断是否为登录态/防盗链资源
    for (i = 0; i < res.videos.length && vidTargets.length < 12; i++) {
      var v = res.videos[i];
      if (/^https?:/i.test(v.url) && (!v.duration || !v.w || !v.h)) { vidTargets.push(v); }
    }
    for (i = 0; i < res.videos.length && vidTargets.length < 12; i++) {
      var v2 = res.videos[i];
      if (/^https?:/i.test(v2.url) && vidTargets.indexOf(v2) < 0) { vidTargets.push(v2); }
    }
    var jobs = [];
    imgTargets.forEach(function (it) {
      jobs.push(MD.probeImage(it.url).then(function (d) {
        if (d) { it.w = it.w || d.w; it.h = it.h || d.h; }
      }));
    });
    vidTargets.forEach(function (it) {
      jobs.push(MD.probeVideo(it.url, 4000).then(function (d) {
        it.probeOk = !!d;
        if (d) {
          it.duration = it.duration || d.duration;
          it.w = it.w || d.w;
          it.h = it.h || d.h;
        }
      }));
    });
    if (!jobs.length) { return Promise.resolve(res); }
    return Promise.race([
      Promise.all(jobs).then(function () { return res; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(res); }, 9000); })
    ]);
  };

  MD.extract = function () {
    var send = function (payload) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      } catch (e) {}
    };
    try {
      MD.autoScroll(2500)
        .then(function () { return MD.collect(); })
        .then(function (res) { return MD.enrich(res); })
        .then(function (res) { send({ __md: 'result', payload: res }); })
        .catch(function (err) { send({ __md: 'error', message: String((err && err.message) || err) }); });
    } catch (err) {
      send({ __md: 'error', message: String((err && err.message) || err) });
    }
  };

  return true;
})();`;

/**
 * 完整注入脚本。
 *
 * 顺序有讲究：NET 必须在 SHARED 之后（依赖它挂好的 window.__MD__ 与规则），
 * 又必须尽量早执行（要覆盖页面加载初期的媒体请求），因此夹在中间。
 */
export const SETUP_SCRIPT =
  `${SHARED_SNIPPET}\n${NET_SNIPPET}\n${COLLECT_SNIPPET}`;

/** 触发采集（页面加载完成或超时兜底后调用） */
export const EXTRACT_SCRIPT = `(function(){ if (window.__MD__ && window.__MD__.extract) { window.__MD__.extract(); } return true; })();`;

/** 轮询页面状态：readyState 与图片加载进度 */
export const PROBE_STATE_SCRIPT = `(function(){ if (window.__MD__ && window.__MD__.probeState) { window.ReactNativeWebView.postMessage(JSON.stringify({ __md: 'state', payload: window.__MD__.probeState() })); } return true; })();`;
