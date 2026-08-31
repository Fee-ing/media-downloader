/**
 * 小红书站点适配。
 *
 * 为什么需要适配：
 * 1. 页面里的 <video src> 是 blob:（走 MediaSource），通用抓取拿不到直链；
 *    作品数据（含 CDN 直链）在页面内嵌的 window.__INITIAL_STATE__ 里。
 * 2. 直链在 note.video.media.stream.h264[].masterUrl（带 sign 签名，可直接下载），
 *    通用抓取即便扫到 INITIAL_STATE 也只得到无标题、无封面的裸条目。
 * 3. 小红书没有可用的 App 侧接口：feed 详情接口依赖页面上下文的 x-s 签名，
 *    直连请求拿不到数据，所以取直链的工作全部交给 pageScript。
 *
 * 实测响应结构（2026-08）：
 *   note.noteDetailMap[noteId].note.title / desc      标题与文案
 *   note.noteDetailMap[noteId].note.type              'video' 才是视频作品
 *   note.noteDetailMap[noteId].note.video.media.stream.h264[]  各清晰度档位
 *     .masterUrl   带签名的 CDN 直链（sns-video-*.xhscdn.com）
 *     .backupUrls  备用 CDN 直链
 *     .width/.height
 *   note.noteDetailMap[noteId].note.video.duration    时长（毫秒）
 *   note.noteDetailMap[noteId].note.video.cover       封面
 */

import type { MediaItem } from '../../types';
import type { SiteAdapter, SiteContext } from './types';

/** 主站域 */
const XHS_HOST = /(^|\.)xiaohongshu\.com$/i;
/** 作品页：/discovery/item/{id}、/explore/{id} */
const XHS_PATH = /^\/(discovery\/item|explore)\/([0-9a-zA-Z]{10,})/;

/**
 * 注入到页面里的采集脚本。
 * 只在匹配的作品页安装，解析 window.__INITIAL_STATE__ 取直链。
 */
export const XHS_PAGE_SCRIPT = `(function () {
  if (window.__MD_XHS__) { return; }
  var MD = window.__MD__;
  if (!MD) { return; }
  var XHS = (window.__MD_XHS__ = {});

  var HOST_RE = /(^|\\.)xiaohongshu\\.com$/i;
  var PATH_RE = /^\\/(discovery\\/item|explore)\\/([0-9a-zA-Z]{10,})/;
  // 小红书视频 CDN 域与特征路径；图片（sns-webpic-*）与头像不算视频
  var VIDEO_CDN_RE = /(^|\\.)sns-video-[\\.\\w-]*\\.xhscdn\\.com$/i;
  var STREAM_RE = /\\/stream\\//i;

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

  function hostOf(u) {
    try { return new URL(u, location.href).hostname; } catch (e) { return ''; }
  }

  /** 通用抓取扫到的本站视频条目（无标题封面、全档位冗余） */
  function isXhsVideo(u) {
    if (!u) { return false; }
    return VIDEO_CDN_RE.test(hostOf(u)) || (/(^|\\.)xhscdn\\.com$/i.test(hostOf(u)) && STREAM_RE.test(u));
  }

  function firstOf(list) {
    if (!list || !list.length) { return ''; }
    for (var i = 0; i < list.length; i++) { if (list[i]) { return list[i]; } }
    return '';
  }

  /** 从 INITIAL_STATE 中定位笔记数据 */
  function findNote(state) {
    if (!state || typeof state !== 'object') { return null; }
    var map = state.note && state.note.noteDetailMap;
    if (map) {
      for (var k in map) {
        var entry = map[k];
        if (entry && entry.note) { return entry.note; }
      }
      return null;
    }
    if (state.noteDetailMap) {
      for (var k2 in state.noteDetailMap) {
        var entry2 = state.noteDetailMap[k2];
        if (entry2 && entry2.note) { return entry2.note; }
      }
      return null;
    }
    // 兜底：state.note 本身就是笔记
    if (state.note && (state.note.video || state.note.imageList)) { return state.note; }
    return null;
  }

  function coverOf(note, video) {
    var c = video && video.cover;
    if (c) {
      var u = c.urlDefault || c.url || '';
      if (u) { return u; }
      var cl = c.urlList || c.imageList;
      var c2 = firstOf(cl);
      if (c2) { return typeof c2 === 'string' ? c2 : (c2.urlDefault || c2.url || ''); }
    }
    var imgs = note.imageList || [];
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i] || {};
      var iu = im.urlDefault || im.url || '';
      if (iu) { return iu; }
    }
    return '';
  }

  /** 挑出可用的视频流：优先 h264（原生可播），其次 av1 / h265 */
  function pickStreams(video) {
    var media = video.media || {};
    var stream = media.stream || {};
    var list = null;
    if (stream.h264 && stream.h264.length) { list = stream.h264; }
    else if (stream.av1 && stream.av1.length) { list = stream.av1; }
    else if (stream.h265 && stream.h265.length) { list = stream.h265; }
    else if (media.video && media.video.length) { list = media.video; }
    return list || [];
  }

  function labelOf(s) {
    if (!s) { return ''; }
    var h = s.height || s.width ? Math.max(s.height || 0, s.width || 0) : 0;
    if (h > 0) { return h + 'P'; }
    var master = s.masterUrl || '';
    var m = /main_([A-Za-z0-9_]+)\\.mp4/i.exec(master);
    if (m) {
      var tag = m[1].replace('_', ' ').toUpperCase();
      if (tag && tag.indexOf('HD') !== -1) { return tag; }
    }
    return '';
  }

  function collect(out, api) {
    var state = null;
    try { state = window.__INITIAL_STATE__ || null; } catch (e) {}
    if (!state) { return; }

    var note = findNote(state);
    if (!note) { return; }
    var video = note.video;
    if (!video) { return; }

    // 确认拿到站点数据后才替换通用层扫到的本站裸条目，否则保留通用层直链兜底
    api.removeVideosBy(isXhsVideo);

    var title = String(note.title || note.desc || '').trim() || '小红书视频';
    var poster = coverOf(note, video);
    var duration = video.duration ? Math.round(video.duration / 1000) : 0;

    var streams = pickStreams(video);
    if (!streams.length) {
      // 兜底：video.url（videoSource 直链）
      if (video.url) {
        api.addVideo({
          url: video.url,
          poster: poster || undefined,
          w: 0,
          h: 0,
          duration: duration || undefined,
          title: title,
          source: 'xiaohongshu'
        });
      }
      return;
    }

    for (var i = 0; i < streams.length; i++) {
      var s = streams[i] || {};
      var master = s.masterUrl || '';
      if (!master || !/^https?:/i.test(master)) { continue; }
      var backups = s.backupUrls || [];
      var fb = '';
      for (var b = 0; b < backups.length; b++) {
        if (backups[b] && backups[b] !== master && /^https?:/i.test(backups[b])) { fb = backups[b]; break; }
      }
      var label = labelOf(s);
      api.addVideo({
        url: master,
        fallbackUrl: fb || undefined,
        poster: poster || undefined,
        w: s.width || 0,
        h: s.height || 0,
        duration: duration || undefined,
        title: label ? title + ' · ' + label : title,
        source: 'xiaohongshu'
      });
    }
  }

  try {
    if (match()) { /* 无需额外安装钩子：INITIAL_STATE 在 collect 时已就绪 */ }
  } catch (e) {}

  MD.sites = MD.sites || [];
  MD.sites.push({
    id: 'xiaohongshu',
    match: match,
    collect: collect
  });

  return true;
})();`;

export const xiaohongshuAdapter: SiteAdapter = {
  id: 'xiaohongshu',
  match(pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      return XHS_HOST.test(parsed.hostname) && XHS_PATH.test(parsed.pathname);
    } catch {
      return false;
    }
  },
  /**
   * 小红书没有可用的 App 侧接口：feed 详情接口依赖页面上下文的 x-s 签名，
   * 直连请求拿不到数据。取直链的工作全部交给 pageScript。
   */
  async fetchVideos(_ctx: SiteContext): Promise<MediaItem[]> {
    return [];
  },
  pageScript: XHS_PAGE_SCRIPT,
};
