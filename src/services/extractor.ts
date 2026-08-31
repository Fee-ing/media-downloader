/**
 * 注入到 WebView 页面中的采集脚本。
 *
 * 分两步：
 * 1. SETUP_SCRIPT 随页面加载注入，挂载 window.__MD__ 工具集；
 * 2. 页面加载完成（或超时兜底）后，调用 window.__MD__.extract() 采集并回传结果。
 *
 * 注意：脚本为纯 ES5 风格，避免老旧 WebView 内核语法报错。
 */

import { SITE_PAGE_SCRIPTS } from './sites';

const BASE_SETUP_SCRIPT = `(function () {
  if (window.__MD__) { return; }
  var MD = (window.__MD__ = {});
  /** 站点专属采集钩子，由各站点的 pageScript 注册 */
  MD.sites = [];

  var IMG_EXT = /\\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif|jfif)(\\?|#|$)/i;
  var VID_EXT = /\\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd|flv|avi|wmv|ts)(\\?|#|$)/i;
  var LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url', 'data-echo', 'data-image', 'data-href', 'data-fallback-src'];
  var SKIP = /(sprite|placeholder|loading\\.gif|blank\\.(png|gif)|1x1|pixel\\.(png|gif)|spacer|icon-)/i;

  /**
   * 从 URL 推断分辨率（仅匹配明确的 宽x高 / w=&h= / 1080p 模式），
   * 签名 CDN 链接常把清晰度写进地址，可作为容器探测前的兜底。
   */
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

  function abs(u) {
    if (!u) { return ''; }
    u = String(u).trim();
    if (!u) { return ''; }
    if (u.indexOf('data:') === 0 || u.indexOf('blob:') === 0) { return ''; }
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

  MD.probeState = function () {
    var total = 0, loaded = 0;
    try {
      var imgs = document.images || [];
      for (var i = 0; i < imgs.length; i++) {
        total++;
        if (imgs[i].complete) { loaded++; }
      }
    } catch (e) {}
    return {
      ready: document.readyState,
      imgTotal: total,
      imgLoaded: loaded
    };
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
   * 网络层嗅探：记录页面运行期间真正发出的媒体请求。
   * 对应 FetchV 扩展里 webRequest.onResponseStarted 的拦截能力——
   * HLS 清单、XHR/fetch 拉取的 mp4、懒加载视频都不会出现在 DOM 里，只能从这里捞。
   */
  var NET_VID_EXT = /\\.(m3u8|m3u|mpd|mp4|m4v|m4s|mov|webm|mkv|ogv|ogg|flv|avi|wmv)(\\?|#|$)/i;
  // 抖音这类 CDN 的直链没有扩展名，只在参数里声明类型（?mime_type=video_mp4）
  var NET_VID_HINT = /[?&]mime_type=video_/i;
  var NET_MAX = 120;
  MD.net = { entries: [], mse: 0, mseMime: '', started: false };

  /**
   * 数据接口的响应体（对应 FetchV 的 CHECK_TEXT_CONTENT）：
   * 直链往往藏在 JSON 响应（playurl / detail / feed 等）或 HLS 清单文本里，
   * 只记 URL 拿不到。这里保存候选接口的响应体，collect 阶段统一解析。
   */
  var PAYLOAD_MAX = 30;
  var PAYLOAD_SIZE_MAX = 1500000;
  MD.payloads = [];
  MD.pushPayload = function (u, text) {
    try {
      if (!u || !text) { return; }
      var full = abs(u);
      if (!full || full.indexOf('http') !== 0) { return; }
      if (text.length > PAYLOAD_SIZE_MAX) { return; }
      var i;
      for (i = 0; i < MD.payloads.length; i++) {
        if (MD.payloads[i].url === full) { return; }
      }
      if (MD.payloads.length >= PAYLOAD_MAX) { return; }
      var type = '';
      var json = null;
      if (text.indexOf('#EXTM3U') === 0) {
        type = 'manifest';
      } else if (text.indexOf('{') === 0 || text.indexOf('[') === 0) {
        try { json = JSON.parse(text); type = 'json'; } catch (e) { type = ''; }
      }
      if (!type) { return; }
      MD.payloads.push({ url: full, type: type, text: text, json: json });
    } catch (e) {}
  };

  /**
   * 候选数据接口：响应体可能是 JSON（内含视频直链）或 HLS 清单文本。
   * 媒体直链与静态资源不在此列，避免无谓的响应体读取开销。
   */
  function isDataUrl(u) {
    var full = abs(u);
    if (!full || full.indexOf('http') !== 0) { return false; }
    if (SKIP.test(full)) { return false; }
    if (NET_VID_EXT.test(full) || NET_VID_HINT.test(full)) { return false; }
    if (/\\.(jpe?g|png|gif|webp|bmp|avif|svg|ico|css|js|woff2?|ttf|eot)([?#]|$)/i.test(full)) { return false; }
    // playurl / view 等接口以 "?bvid=..." 结尾，所以分隔符放宽到 /、? 或结尾
    return /\\/(api|ajax|sns\\/web|aweme|playurl|detail|feed|discovery|item|note|view|recommend|search|graphql)(\\/|\\?|$)|\\/x\\/player\\//i.test(full);
  }

  MD.netPush = function (u, extra) {
    try {
      if (!u) return;
      var full = abs(u);
      if (!full || full.indexOf('http') !== 0) return;
      if (!(NET_VID_EXT.test(full) || NET_VID_HINT.test(full)) || SKIP.test(full)) return;
      var i;
      for (i = 0; i < MD.net.entries.length; i++) {
        if (MD.net.entries[i].url === full) return;
      }
      if (MD.net.entries.length >= NET_MAX) return;
      var entry = { url: full, size: 0 };
      if (extra) { for (var k in extra) { if (k !== 'url') entry[k] = extra[k]; } }
      MD.net.entries.push(entry);
    } catch (e) {}
  };

  MD.startNet = function () {
    if (MD.net.started) return;
    MD.net.started = true;

    // 1) Resource Timing：覆盖 <video>/XHR/fetch 等各类请求，还能拿到真实体积
    try {
      if (window.PerformanceObserver) {
        var po = new PerformanceObserver(function (list) {
          try {
            var items = list.getEntries ? list.getEntries() : [];
            for (var i = 0; i < items.length; i++) {
              var e = items[i];
              var size = e.encodedBodySize || e.decodedBodySize || e.transferSize || 0;
              MD.netPush(e.name, { size: size, initiator: e.initiatorType || '', viaNetwork: true });
            }
          } catch (err) {}
        });
        po.observe({ entryTypes: ['resource'] });
      }
    } catch (e) {}

    // 2) fetch
    try {
      var originFetch = window.fetch;
      if (typeof originFetch === 'function') {
        window.fetch = function (input) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url) || '';
            MD.netPush(u, { initiator: 'fetch', viaNetwork: true });
            if (isDataUrl(u)) {
              // 数据接口：异步读响应体，供 collect 解析（HLS 清单 / JSON 直链）
              var pending = originFetch.apply(this, arguments);
              try {
                if (pending && typeof pending.then === 'function') {
                  pending.then(function (res) {
                    try {
                      if (!res || !res.ok) { return; }
                      var fu = res.url || u;
                      if (!isDataUrl(fu)) { return; }
                      var copy = res.clone();
                      if (copy && typeof copy.text === 'function') {
                        copy.text().then(function (t) { MD.pushPayload(fu, t); });
                      }
                    } catch (e) {}
                    return res;
                  });
                }
              } catch (e) {}
              return pending;
            }
          } catch (err) {}
          return originFetch.apply(this, arguments);
        };
      }
    } catch (e) {}

    // 3) XMLHttpRequest
    try {
      var originOpen = XMLHttpRequest.prototype.open;
      var originSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, u) {
        try { this.__mdUrl = String(u || ''); MD.netPush(u, { initiator: 'xmlhttprequest', viaNetwork: true }); } catch (err) {}
        return originOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          var self = this;
          var xhrUrl = self.__mdUrl || '';
          if (isDataUrl(xhrUrl)) {
            self.addEventListener('load', function () {
              try {
                if (self.readyState !== 4) { return; }
                MD.pushPayload(xhrUrl, self.responseText || '');
              } catch (e) {}
            });
          }
        } catch (e) {}
        return originSend.apply(this, arguments);
      };
    } catch (e) {}

    // 4) MSE：页面用 MediaSource 播放时，视频是脚本合成的内存流，没有直链
    try {
      if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
        var originAdd = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (mime) {
          try { MD.net.mse += 1; MD.net.mseMime = String(mime); } catch (err) {}
          return originAdd.apply(this, arguments);
        };
      }
    } catch (e) {}
  };
  MD.startNet();

  /**
   * 生成往指定结果集里追加图片 / 视频的函数。
   * 站点钩子在 collect 之后运行，也要走同一套去重与补全逻辑，
   * 因此把这两个函数从 collect 的闭包里提出来复用。
   */
  function makeAdder(out, seen, timing) {
    return {
      addImage: function (o) {
        o.url = abs(o.url);
        if (!o.url || seen['i' + o.url] || SKIP.test(o.url)) { return; }
        seen['i' + o.url] = true;
        o.w = o.w > 0 ? Math.round(o.w) : 0;
        o.h = o.h > 0 ? Math.round(o.h) : 0;
        if (o.w && o.h && o.w < 48 && o.h < 48) { return; }
        if (!o.size) { o.size = timing[o.url]; }
        out.images.push(o);
      },
      addVideo: function (o) {
        o.url = abs(o.url);
        if (!o.url || seen['v' + o.url] || SKIP.test(o.url)) { return; }
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
        out.videos.push(o);
      },
      /**
       * 按 URL 特征批量移除视频并解除去重标记。
       * 站点钩子拿接口全量数据时，用它将通用层扫到的本站裸条目「替换」成精选条目，
       * 否则被移除的 URL 仍占着去重标记，精选条目加不进来。
       */
      removeVideosBy: function (test) {
        var removed = [];
        var i = 0;
        while (i < out.videos.length) {
          var u = out.videos[i].url;
          if (test(u)) {
            removed.push(u);
            out.videos.splice(i, 1);
          } else {
            i++;
          }
        }
        for (var j = 0; j < removed.length; j++) {
          delete seen['v' + removed[j]];
        }
      },
    };
  }

  /**
   * 判定站点归属时使用的地址。
   *
   * 默认是当前页面地址，但页面可能已经跳转：抖音在触发风控时会跳到 /jingxuan
   * （推荐流），此时 location 不再指向用户要抓的作品。用户输入的原始地址才是真实意图，
   * 因此优先采用它——即便页面跳转，也能按作品页继续处理。
   */
  MD.pageHref = function () {
    try {
      return window.__MD_TASK_URL__ || location.href;
    } catch (e) {
      return '';
    }
  };

  /** 按结果集缓存追加函数，保证同一轮采集里 DOM 阶段与站点阶段共用一份去重表 */
  var adderCache = [];
  MD.adderFor = function (out) {
    for (var i = 0; i < adderCache.length; i++) {
      if (adderCache[i].out === out) { return adderCache[i].adder; }
    }
    var adder = makeAdder(out, {}, timingMap());
    adderCache.push({ out: out, adder: adder });
    return adder;
  };

  MD.collect = function () {
    var out = {
      title: document.title || '',
      pageUrl: location.href,
      cookie: '',
      mse: MD.net.mse > 0,
      blobVideos: 0,
      images: [],
      videos: [],
    };
    try { out.cookie = document.cookie || ''; } catch (e) {}
    var adder = MD.adderFor(out);
    var addImage = adder.addImage;
    var addVideo = adder.addVideo;

    // 1. <img>
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i];
      var raw = el.currentSrc || el.getAttribute('src') || '';
      if (!raw) {
        var ss = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (ss) { raw = bestSrcset(ss); }
      }
      if (!raw) { raw = attrFrom(el, LAZY_ATTRS); }
      if (!raw) { continue; }
      addImage({
        url: raw,
        w: el.naturalWidth || 0,
        h: el.naturalHeight || 0,
        title: nearbyTitle(el),
        source: 'img'
      });
    }

    // 2. <picture><source srcset>
    var sources = document.querySelectorAll('picture source[srcset]');
    for (var s = 0; s < sources.length; s++) {
      addImage({
        url: bestSrcset(sources[s].getAttribute('srcset')),
        w: 0,
        h: 0,
        title: nearbyTitle(sources[s].parentElement || sources[s]),
        source: 'picture'
      });
    }

    // 3. <a href> 指向图片
    var links = document.querySelectorAll('a[href]');
    for (var l = 0; l < links.length; l++) {
      var href = links[l].getAttribute('href') || '';
      if (!href || href.indexOf('#') === 0) { continue; }
      var full = abs(href);
      if (!full) { continue; }
      if (IMG_EXT.test(full)) {
        addImage({ url: full, w: 0, h: 0, title: text(links[l]).slice(0, 120), source: 'link' });
      } else if (VID_EXT.test(full)) {
        addVideo({ url: full, w: 0, h: 0, title: text(links[l]).slice(0, 120), source: 'link' });
      }
    }

    // 4. 背景图
    var nodes = document.querySelectorAll('*');
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

    // 5. <video> 与其 <source>
    var vids = document.querySelectorAll('video');
    for (var vi = 0; vi < vids.length; vi++) {
      var vEl = vids[vi];
      var vRaw = vEl.currentSrc || vEl.getAttribute('src') || '';
      if (!vRaw) {
        var vs = vEl.querySelectorAll('source');
        for (var k = 0; k < vs.length; k++) {
          var cand = vs[k].getAttribute('src') || vs[k].getAttribute('data-src') || '';
          if (cand) { vRaw = cand; break; }
        }
      }
      if (!vRaw) { vRaw = attrFrom(vEl, LAZY_ATTRS); }
      if (!vRaw) { continue; }
      if (vRaw.indexOf('blob:') === 0) {
        // 脚本实时合成的内存流，没有直链；真实地址通常能在网络层记录里找到
        out.blobVideos += 1;
        continue;
      }
      addVideo({
        url: vRaw,
        poster: abs(vEl.getAttribute('poster') || '') || undefined,
        w: vEl.videoWidth || 0,
        h: vEl.videoHeight || 0,
        duration: vEl.duration && isFinite(vEl.duration) && vEl.duration > 0 ? vEl.duration : undefined,
        title: nearbyTitle(vEl),
        source: 'video'
      });
    }

    // 6. <video>/<audio> 之外独立出现的 <source>
    var mediaSources = document.querySelectorAll('source[src]');
    for (var ms = 0; ms < mediaSources.length; ms++) {
      var srcVal = mediaSources[ms].getAttribute('src') || '';
      if (!srcVal) { continue; }
      if (srcVal.indexOf('blob:') === 0) { out.blobVideos += 1; continue; }
      if (VID_EXT.test(srcVal)) {
        addVideo({ url: srcVal, w: 0, h: 0, title: '', source: 'source' });
      }
    }

    // 7. 结构化数据（JSON-LD）
    var ldNodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (var j = 0; j < ldNodes.length; j++) {
      var data = null;
      try { data = JSON.parse(ldNodes[j].textContent || ''); } catch (e) { data = null; }
      if (!data) { continue; }
      var stack = [data];
      var guardCount = 0;
      while (stack.length && guardCount < 200) {
        guardCount++;
        var cur = stack.pop();
        if (!cur || typeof cur !== 'object') { continue; }
        if (Array.isArray(cur)) {
          for (var a = 0; a < cur.length; a++) { stack.push(cur[a]); }
          continue;
        }
        var type = cur['@type'] || '';
        var types = Array.isArray(type) ? type.join(',') : String(type);
        if (/VideoObject/i.test(types) && cur.contentUrl) {
          addVideo({
            url: cur.contentUrl,
            poster: cur.thumbnailUrl ? (Array.isArray(cur.thumbnailUrl) ? cur.thumbnailUrl[0] : cur.thumbnailUrl) : undefined,
            w: cur.width || 0,
            h: cur.height || 0,
            duration: isoDuration(cur.duration),
            title: (cur.name || cur.headline || '').slice(0, 120),
            source: 'ld+json'
          });
        } else if (/ImageObject/i.test(types) && cur.contentUrl) {
          addImage({
            url: cur.contentUrl,
            w: cur.width || 0,
            h: cur.height || 0,
            title: (cur.name || cur.caption || '').slice(0, 120),
            source: 'ld+json'
          });
        }
        for (var key in cur) {
          if (Object.prototype.hasOwnProperty.call(cur, key) && typeof cur[key] === 'object') {
            stack.push(cur[key]);
          }
        }
      }
    }

    // 8. OpenGraph / meta
    function metaContent(selector) {
      var node = document.querySelector(selector);
      return node ? abs(node.getAttribute('content') || '') : '';
    }
    var ogImage = metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');
    if (ogImage) {
      addImage({ url: ogImage, w: 0, h: 0, title: out.title, source: 'meta' });
    }
    // og:video 经常指向站点的「外链播放器页面」（如 B 站的 player.bilibili.com/player.html），
    // 那是一个 HTML 页面而不是媒体文件，收录进来只会得到一条永远放不出的条目。
    var ogVideoType = (function () {
      var node = document.querySelector('meta[property="og:video:type"]');
      return node ? String(node.getAttribute('content') || '').toLowerCase() : '';
    })();
    var ogVideo = metaContent('meta[property="og:video"]') || metaContent('meta[property="og:video:url"]');
    var ogVideoIsPage = !ogVideo || ogVideoType.indexOf('text/html') === 0 || /\\.html?(\\?|#|$)/i.test(ogVideo);
    if (ogVideo && !ogVideoIsPage) {
      addVideo({ url: ogVideo, w: 0, h: 0, title: out.title, source: 'meta' });
    }

    // 9. 网络层捕获到的媒体请求（HLS 清单、XHR/fetch 拉取的 mp4 等）
    var netList = MD.net ? MD.net.entries : [];
    var isManifest = function (u) { return /\\.(m3u8|m3u|mpd)(\\?|#|$)/i.test(u); };
    var plainOf = function (u) { return u.split('?')[0].split('#')[0]; };
    var dirOf = function (u) {
      var s = plainOf(u);
      var i = s.lastIndexOf('/');
      return i > -1 ? s.slice(0, i) : s;
    };
    var extOf = function (u) {
      var m = /\\.([a-zA-Z0-9]{2,5})$/.exec(plainOf(u));
      return m ? m[1].toLowerCase() : '';
    };
    // 分片特征：同目录下 3 个以上「同前缀 + 递增编号」的同扩展名资源（seg1/seg2/seg3…）
    var seqInfo = function (u) {
      var base = (plainOf(u).split('/').pop() || '').replace(/\\.[a-zA-Z0-9]{2,5}$/, '');
      var m = /^(.*?)([0-9]{1,6})$/.exec(base);
      return m ? dirOf(u) + '|' + extOf(u) + '|' + m[1] : null;
    };
    var groups = {};
    for (var gi = 0; gi < netList.length; gi++) {
      var gKey = seqInfo(netList[gi].url);
      if (gKey) groups[gKey] = (groups[gKey] || 0) + 1;
    }
    var isSegment = function (u) {
      var key = seqInfo(u);
      return !!key && (groups[key] || 0) >= 3;
    };
    for (var nq = 0; nq < netList.length; nq++) {
      var ne = netList[nq];
      // 清单永远保留，只有分片才会被丢弃
      if (!isManifest(ne.url) && isSegment(ne.url)) continue;
      addVideo({
        url: ne.url,
        w: 0,
        h: 0,
        size: ne.size || 0,
        title: '',
        source: 'network',
        viaNetwork: true,
      });
    }

    // 10) 数据接口响应体（HLS 清单文本 / JSON 里的直链）与页面内嵌初始化数据。
    //     与 FetchV 的 CHECK_TEXT_CONTENT 思路一致：直链往往藏在接口 JSON 或页面
    //     内嵌的 __playinfo__ / __INITIAL_STATE__ 等数据里，仅记录请求 URL 抓不到。
    var VIDEO_KEY_HINT = /(masterUrl|backupUrl|baseUrl|playUrl|play_url|playAddr|play_addr|url_list|videoUrl|video_url|srcUrl|downloadUrl|streamUrl|mediaUrl|originVideoKey|playlink)/i;
    var IMG_EXT_RE = /\\.(jpe?g|png|gif|webp|bmp|avif|svg|ico)([?#]|$)/i;
    var MEDIA_HOST_RE = /(\\/video\\/|\\/play\\/|\\/stream\\/|\\/upos|bilivideo|douyinvod|aweme|amemv|snssdk|xhscdn|snap)/i;
    var toDim = function (v) {
      if (typeof v === 'number' && isFinite(v)) { return Math.round(v); }
      if (typeof v === 'string') {
        var n = parseFloat(v);
        return isFinite(n) ? Math.round(n) : 0;
      }
      return 0;
    };
    /**
     * 从 JSON 对象里提取宽高（常见字段：width/height、w/h、videoWidth/…），
     * 站点接口的播放地址旁往往带这几个字段，比事后探测更可靠。
     */
    var dimOf = function (o) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) { return null; }
      var W_KEYS = ['width', 'w', 'videoWidth', 'video_width', 'awemeWidth', 'img_width', 'res_w'];
      var H_KEYS = ['height', 'h', 'videoHeight', 'video_height', 'awemeHeight', 'img_height', 'res_h'];
      var w = 0, h = 0, i, v;
      for (i = 0; i < W_KEYS.length; i++) {
        v = toDim(o[W_KEYS[i]]);
        if (v > 0 && v < 20000) { w = v; break; }
      }
      for (i = 0; i < H_KEYS.length; i++) {
        v = toDim(o[H_KEYS[i]]);
        if (v > 0 && v < 20000) { h = v; break; }
      }
      return w && h ? { w: w, h: h } : null;
    };
    var isVideoish = function (u, key) {
      if (!u || u.indexOf('http') !== 0) { return false; }
      if (SKIP.test(u)) { return false; }
      if (IMG_EXT_RE.test(u)) { return false; }
      if (NET_VID_EXT.test(u)) { return true; }
      if (NET_VID_HINT.test(u)) { return true; }
      return VIDEO_KEY_HINT.test(key || '') && MEDIA_HOST_RE.test(u);
    };
    var scanBudget = 6000;
    var scanJson = function (obj) {
      if (!obj || typeof obj !== 'object') { return; }
      var stack = [{ o: obj, p: null }];
      var visited = 0;
      var key, val, ai;
      while (stack.length && visited < scanBudget) {
        var item = stack.pop();
        visited++;
        var cur = item.o;
        var parent = item.p;
        if (!cur || typeof cur !== 'object') { continue; }
        if (Array.isArray(cur)) {
          for (ai = 0; ai < cur.length; ai++) { stack.push({ o: cur[ai], p: parent }); }
          continue;
        }
        for (key in cur) {
          if (!Object.prototype.hasOwnProperty.call(cur, key)) { continue; }
          val = cur[key];
          if (typeof val === 'string' && val.length > 10) {
            if (isVideoish(val, key)) {
              // 播放地址旁的 width/height（或其父对象）是比事后探测更准的来源
              var dim = dimOf(cur) || dimOf(parent);
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
            stack.push({ o: val, p: cur });
          }
        }
      }
    };
    var pl;
    for (var pi = 0; pi < MD.payloads.length; pi++) {
      pl = MD.payloads[pi];
      if (pl.type === 'manifest') {
        addVideo({ url: pl.url, w: 0, h: 0, size: 0, title: '', source: 'json' });
      } else if (pl.type === 'json' && pl.json) {
        scanJson(pl.json);
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
      var SCAN_LIMIT = 8;
      var scanned = 0;
      for (var si = 0; si < scripts.length && scanned < SCAN_LIMIT; si++) {
        var node = scripts[si];
        if (node.src) { continue; }
        var text = node.textContent || '';
        if (!text || text.length > 4000000) { continue; }
        var nodeType = String(node.type || '').toLowerCase();
        if (nodeType === 'application/json') {
          try { scanJson(JSON.parse(text)); scanned++; } catch (e) {}
          continue;
        }
        if (nodeType && nodeType !== 'text/javascript' && nodeType !== 'module' && nodeType !== 'application/javascript') { continue; }
        var re = /window\\.([A-Za-z_$][\\w$]*)\\s*=\\s*(\\{)/g;
        var m;
        while ((m = re.exec(text)) !== null) {
          var keyName = m[1];
          if (!/(INIT|playinfo|NEXT|NUXT|SSR|DATA|STATE|PLAYINFO)/i.test(keyName)) { continue; }
          var jsonText = extractBalanced(text, m.index + m[0].length - 1);
          if (!jsonText || jsonText.length > 2000000) { continue; }
          try { scanJson(JSON.parse(jsonText)); } catch (e) {}
          scanned++;
          if (scanned >= SCAN_LIMIT) { break; }
        }
      }
    };
    scanInlineScripts();

    return out;
  };

  /**
   * 站点专属采集：抖音这类站点要补的接口数据在 DOM 上不存在，需要额外请求。
   * 站点钩子可以改写 out.images / out.videos（例如丢掉站点自己的占位素材），
   * 因此放在通用采集之后执行。
   *
   * 钩子可以是同步的，也可以返回 Promise——抖音就是异步的（要现请求详情接口）。
   * 单个站点抛错不影响其它站点，也不影响已经采到的通用结果。
   */
  MD.runSites = function (out) {
    var api = MD.adderFor(out);
    var sites = [];
    var pool = MD.sites || [];
    var i;
    for (i = 0; i < pool.length; i++) {
      var site = pool[i];
      if (!site || !site.collect) { continue; }
      var matched = false;
      try { matched = site.match(MD.pageHref()); } catch (e) { matched = false; }
      if (matched) { sites.push(site); }
    }
    var index = 0;
    function next() {
      if (index >= sites.length) { return Promise.resolve(out); }
      var current = sites[index++];
      try {
        return Promise.resolve(current.collect(out, api)).then(next, next);
      } catch (e) {
        return next();
      }
    }
    return next();
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
        // 站点钩子可能要现请求接口（抖音的详情接口就是），必须等它完成再回传
        .then(function (res) { return MD.runSites(res); })
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
 * 通用脚本 + 各站点的页面采集脚本。
 * 站点脚本依赖通用脚本挂好的 window.__MD__，必须排在后面。
 */
export const SETUP_SCRIPT = SITE_PAGE_SCRIPTS
  ? `${BASE_SETUP_SCRIPT}\n${SITE_PAGE_SCRIPTS}`
  : BASE_SETUP_SCRIPT;

/**
 * 生成注入脚本，并记录用户输入的原始地址。
 *
 * 必须先于 SETUP_SCRIPT 写入 __MD_TASK_URL__：站点脚本在注册时就要用它判断归属。
 * 页面一旦跳转到风控页/首页，location 就不再是用户想抓的页面，只有原始地址可信。
 */
export function buildSetupScript(taskUrl: string): string {
  let literal = '""';
  try {
    literal = JSON.stringify(taskUrl || '');
  } catch {
    literal = '""';
  }
  return `window.__MD_TASK_URL__ = ${literal};\n${SETUP_SCRIPT}`;
}

/** 触发采集（页面加载完成或超时兜底后调用） */
export const EXTRACT_SCRIPT = `(function(){ if (window.__MD__ && window.__MD__.extract) { window.__MD__.extract(); } return true; })();`;

/** 轮询页面状态：readyState 与图片加载进度 */
export const PROBE_STATE_SCRIPT = `(function(){ if (window.__MD__ && window.__MD__.probeState) { window.ReactNativeWebView.postMessage(JSON.stringify({ __md: 'state', payload: window.__MD__.probeState() })); } return true; })();`;
