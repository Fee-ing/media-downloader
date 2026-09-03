/**
 * B 站站点适配层。
 *
 * B 站是 DASH 音画分离：video[] 是纯视频轨（.m4s，无声），audio[] 是伴音轨。
 * 两者在 URL 上毫无区别，通用规则只能捞到视频轨，于是「播放无声 + 下载只得无声
 * m4s」；不同清晰度的视频轨也都长一个样（30064/30216/30280…），通用折叠逻辑又
 * 会把它们压成一条，用户看不到也选不了。
 *
 * 这些只有 B 站自己的数据结构能说清楚，因此独立成适配层，通过
 * services/sites/types.ts 的通用契约喂回主链路：
 *
 *   - 从 playinfo / INITIAL_STATE / playurl 接口响应里读完整的轨道表，
 *     每档清晰度带 width / height / qn，逐条交给通用 adder；
 *   - 给每条视频轨打 variantGroup + qualityId + qualityLabel，
 *     主链路据此「各清晰度保留为独立条目、同档位的 CDN 镜像仍合并」；
 *   - 把 audio[] 全部登记为伴音轨（declareAudio），保证音画配对与合并下载。
 *
 * 页面脚本为纯 ES5，且不依赖任何 B 站全局变量以外的东西。
 */

import type { SiteAdapter, SiteDebug } from './types';

// ============================================================
// 页面侧脚本
// ============================================================

const BILIBILI_SNIPPET = `(function () {
  var MD = window.__MD__;
  if (!MD) { return; }
  var S = (MD.sites = MD.sites || {});

  /** B 站清晰度档位：dash.video[].id 即 qn */
  var QUALITY = {
    6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
    80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K',
    125: 'HDR', 126: '杜比视界', 127: '8K'
  };

  /** 已拿到的播放信息（含 area，便于比较哪份更清晰） */
  var CACHE = null;
  var WATCHING = false;

  function host() {
    try { return location.hostname.toLowerCase(); } catch (e) { return ''; }
  }
  function isBili() {
    return /(^|\\.)bilibili\\.com$/i.test(host());
  }
  /** 登录态：未登录时 B 站只肯给 360P */
  function isLogin() {
    try { return /(?:^|;\\s*)SESSDATA=/.test(document.cookie || ''); } catch (e) { return false; }
  }

  function bvidOf() {
    var m = null;
    try { m = /\\/video\\/(BV[0-9A-Za-z]{10})/.exec(location.pathname); } catch (e) {}
    if (m) { return m[1]; }
    try { m = /[?&]bvid=(BV[0-9A-Za-z]{10})/.exec(location.search); } catch (e) {}
    if (m) { return m[1]; }
    try {
      var st = window.__INITIAL_STATE__;
      if (st && st.videoData && st.videoData.bvid) { return st.videoData.bvid; }
    } catch (e) {}
    return '';
  }

  function cidOf() {
    var m = null;
    try { m = /[?&]cid=([0-9]+)/.exec(location.search); } catch (e) {}
    if (m) { return m[1]; }
    try {
      var st = window.__INITIAL_STATE__;
      if (st && st.videoData && st.videoData.cid) { return String(st.videoData.cid); }
      if (st && st.cid) { return String(st.cid); }
    } catch (e) {}
    return '';
  }

  function maxArea(videos) {
    var max = 0;
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i] || {};
      var w = parseInt(v.width || 0, 10) || 0;
      var h = parseInt(v.height || 0, 10) || 0;
      if (w * h > max) { max = w * h; }
    }
    return max;
  }

  /** 播放信息源一：内联的 window.__playinfo__（桌面版最常见） */
  function fromGlobal() {
    try {
      var raw = window.__playinfo__;
      if (raw && raw.data && raw.data.dash && raw.data.dash.video && raw.data.dash.video.length) {
        return { dash: raw.data.dash, source: 'playinfo', cid: '' };
      }
    } catch (e) {}
    return null;
  }

  /** 播放信息源二：window.__INITIAL_STATE__.playinfo */
  function fromInitialState() {
    try {
      var st = window.__INITIAL_STATE__;
      var raw = st && st.playinfo;
      if (raw && raw.data && raw.data.dash && raw.data.dash.video && raw.data.dash.video.length) {
        return { dash: raw.data.dash, source: 'initial-state', cid: '' };
      }
    } catch (e) {}
    return null;
  }

  /**
   * 播放信息源三：playurl 接口的响应体。
   *
   * B 站并不是所有场景都会挂 window.__playinfo__（嵌入播放器、改版页面、切换
   * 清晰度后的重新请求都不会更新它），但一定发过 playurl 请求，响应体已被通用
   * 网络层存进 NET.payloads。这里把它翻出来：既能在 playinfo 缺失时兜底，也能
   * 拿到「用户手动切换清晰度后」返回的那份更高清的轨道表。
   */
  function fromPayloads() {
    var list = null;
    try { list = (MD.net && MD.net.payloads) || MD.payloads || []; } catch (e) { return null; }
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.json) { continue; }
      var u = String(p.url || '');
      if (u.indexOf('playurl') < 0) { continue; }
      var d = p.json && p.json.data;
      if (!d || !d.dash || !d.dash.video || !d.dash.video.length) { continue; }
      var area = maxArea(d.dash.video);
      if (!best || area > best.area) {
        var m = /[?&]cid=([0-9]+)/.exec(u);
        best = { dash: d.dash, source: 'playurl', cid: m ? m[1] : '', area: area };
      }
    }
    return best;
  }

  /** 扫描全部来源，取分辨率最高的那一份 */
  function scan() {
    var cands = [fromGlobal(), fromInitialState(), fromPayloads()];
    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c) { continue; }
      if (!c.area) { c.area = maxArea(c.dash.video); }
      if (!best || c.area > best.area) { best = c; }
    }
    return best;
  }

  /**
   * 取当前可用的播放信息。
   *
   * 每次都重新扫描（而不是命中缓存就返回）：用户在网页里把清晰度切到 4K 后
   * 点「重新解析」，playinfo 那份仍是初始的 360P，但 NET.payloads 里已经躺着
   * 新的 playurl 响应——重新扫描才能把更高清的轨道表换上来。
   */
  function findDash() {
    var found = scan();
    if (found && (!CACHE || found.area > CACHE.area)) { CACHE = found; }
    return CACHE;
  }

  function labelOf(id, height, frameRate) {
    var q = QUALITY[parseInt(id, 10) || 0];
    if (q) { return q; }
    if (!height) { return ''; }
    var fps = 0;
    var m = /^([0-9]+)\\/([0-9]+)$/.exec(String(frameRate || ''));
    if (m) {
      fps = parseFloat(m[1]) / (parseFloat(m[2]) || 1);
    } else {
      fps = parseFloat(frameRate || '') || 0;
    }
    return fps > 32 ? height + 'P60' : height + 'P';
  }

  function firstUrl(o) {
    if (!o) { return ''; }
    return o.baseUrl || (o.backupUrl && o.backupUrl[0]) || o.base_url || o.url || '';
  }

  // ---------------------------------------------------------
  // 契约实现
  // ---------------------------------------------------------

  /**
   * 页面加载即启动的后台守望。
   *
   * B 站的 playinfo 是延迟写入的，采集阶段才开始等往往已经来不及；这里从
   * 网络层钩子装好（DOMContentLoaded 之前）就开始轮询，等到采集时基本已经
   * 就位，不必再串行占用采集时间。
   */
  function watch() {
    if (WATCHING || !isBili()) { return; }
    WATCHING = true;
    var tries = 0;
    var timer = window.setInterval(function () {
      tries++;
      findDash();
      if (CACHE || tries > 300) { window.clearInterval(timer); }
    }, 300);
  }

  /** 采集前的最后一次等待：仍未就绪时轻触播放按钮，逼播放器初始化 */
  function wait(timeoutMs) {
    return new Promise(function (resolve) {
      if (!isBili()) { resolve(false); return; }
      if (findDash()) { resolve(true); return; }
      var total = timeoutMs || 8000;
      var deadline = Date.now() + total;
      var nudged = false;
      var timer = window.setInterval(function () {
        if (findDash()) {
          window.clearInterval(timer);
          resolve(true);
          return;
        }
        // 移动端页面（m.bilibili.com）要用户交互才初始化播放器，轻触一下播放键。
        // 只点一次，且只点播放器自身的播放按钮，不模拟其它行为。
        if (!nudged && Date.now() > deadline - total * 0.5) {
          nudged = true;
          try {
            var btn = document.querySelector(
              '.bpx-player-ctrl-play, .bilibili-player-video-btn-start, .player-btn-start, .mplayer-play-btn'
            );
            if (btn && btn.click) { btn.click(); }
          } catch (e) {}
        }
        if (Date.now() > deadline) {
          window.clearInterval(timer);
          resolve(false);
        }
      }, 200);
    });
  }

  function collect(addVideo) {
    if (!isBili()) { return { id: 'bilibili', matched: false }; }

    var found = findDash();
    if (!found) {
      // 拿不到播放信息：只能靠通用网络层嗅探，抓到的是播放器当前在播的那一档
      return {
        id: 'bilibili', matched: true, source: null, degraded: true,
        loggedIn: isLogin(), videoTracks: 0, audioTracks: 0
      };
    }

    var dash = found.dash;
    var videos = dash.video || [];
    var audios = dash.audio || [];
    if (!videos.length) {
      return {
        id: 'bilibili', matched: true, source: found.source, degraded: true,
        loggedIn: isLogin(), videoTracks: 0, audioTracks: audios.length
      };
    }

    var group = 'bili:' + (bvidOf() || '') + ':' + (found.cid || cidOf() || '');
    var duration = dash.duration ? parseFloat(dash.duration) : undefined;
    var title = '';
    try { title = document.title || ''; } catch (e) {}

    // 伴音轨：按带宽从高到低，逐个作为下载 / 播放的兜底。
    // 只留一条时，恰好该节点失效就会「有画面没声音」。
    var audioList = [];
    for (var a = 0; a < audios.length; a++) {
      var au = audios[a];
      // baseUrl 在 B 站常被置空，真正的可下载地址在 backupUrl[0]
      var auUrl = firstUrl(au);
      if (!auUrl) { continue; }
      audioList.push({ url: auUrl, bw: parseInt(au.bandwidth || au.BandWidth || 0, 10) || 0 });
      // 备用地址也登记为音轨：网络层抓到的常是 backupUrl 里的镜像
      if (au.backupUrl && au.backupUrl.length) {
        for (var b = 0; b < au.backupUrl.length; b++) { MD.declareAudio(au.backupUrl[b]); }
      }
      MD.declareAudio(auUrl);
    }
    audioList.sort(function (x, y) { return y.bw - x.bw; });
    var audioUrls = [];
    for (var ai = 0; ai < audioList.length; ai++) { audioUrls.push(audioList[ai].url); }

    var qualities = [];
    for (var v = 0; v < videos.length; v++) {
      var vv = videos[v];
      var vUrl = firstUrl(vv);
      if (!vUrl) { continue; }
      var height = parseInt(vv.height || 0, 10) || 0;
      var width = parseInt(vv.width || 0, 10) || 0;
      var label = labelOf(vv.id, height, vv.frame_rate);
      if (label) { qualities.push(label); }
      addVideo({
        url: vUrl,
        w: width,
        h: height,
        duration: duration,
        title: title,
        source: 'json',
        audioTrackUrl: audioUrls[0] || undefined,
        audioTrackUrls: audioUrls.length ? audioUrls.slice() : undefined,
        // 契约字段：告诉主链路「这些是同一视频的不同清晰度，别折叠成一条」
        variantGroup: group,
        qualityId: parseInt(vv.id || 0, 10) || 0,
        qualityLabel: label
      });
    }

    return {
      id: 'bilibili', matched: true, source: found.source, degraded: false,
      loggedIn: isLogin(), videoTracks: videos.length, audioTracks: audios.length,
      topQuality: qualities.length ? qualities[qualities.length - 1] : '',
      qualities: qualities
    };
  }

  S.bilibili = {
    watch: watch,
    wait: wait,
    collect: collect,
    isBili: isBili,
    findDash: findDash
  };

  return true;
})();`;

// ============================================================
// RN 侧适配
// ============================================================

function matchBilibili(url: string): boolean {
  try {
    return /(^|\.)bilibili\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function noteOf(debug: SiteDebug): string | undefined {
  if (!debug.matched) return undefined;
  const parts: string[] = [];
  if (!debug.loggedIn) {
    parts.push('网页未登录 B 站账号，最高只能获取 480P；登录后重新抓取可解锁更高清晰度');
  }
  if (debug.degraded) {
    parts.push(
      '未能读取 B 站播放信息，抓到的是播放器当前播放的那一档；' +
        '可在网页内把清晰度切到最高，播放几秒后再重新解析',
    );
  }
  return parts.length ? parts.join('；') : undefined;
}

export const bilibiliAdapter: SiteAdapter = {
  id: 'bilibili',
  label: '哔哩哔哩',
  match: matchBilibili,
  snippet: BILIBILI_SNIPPET,
  note: noteOf,
};
