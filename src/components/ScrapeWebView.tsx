import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from 'react-native-webview';

import { COLORS, DESKTOP_UA, TIMING } from '../constants';
import {
  EXTRACT_SCRIPT,
  PROBE_STATE_SCRIPT,
  buildSetupScript,
} from '../services/extractor';
import { matchAdapter } from '../services/sites';
import type { RawScrapePayload, ScrapeProgress } from '../types';

/** 抖音作品页/分享页的域与路径，用于识别「已被风控重定向到首页/落地页」 */
const DOUYIN_OK_HOST = /(^|\.)(douyin|iesdouyin)\.com$/i;
const DOUYIN_OK_PATH = /^\/(video|note|share\/video|share\/note)\/\d{6,}/;
/** 风控重定向拉回上限：每次拉回都会带上上一轮下发的 cookie，通常 1-2 次即正常 */
const MAX_REDIRECT_RETRY = 3;

function isDouyinOkUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return DOUYIN_OK_HOST.test(parsed.hostname) && DOUYIN_OK_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * 媒体全局静音（在页面脚本执行前注入）。
 *
 * 抓取依赖自动播放（静音后浏览器仍允许自动播放，媒体请求照常发出，
 * 网络层嗅探不受影响），因此不能关掉 mediaPlaybackRequiresUserAction，
 * 而是拦截 HTMLMediaElement.play/load 并强制 muted，避免抓取时听到页面声音。
 */
const MUTE_MEDIA_SCRIPT = `(function () {
  if (window.__MD_MUTE__) { return true; }
  window.__MD_MUTE__ = true;
  function mute(el) {
    try {
      if (!el.muted) { el.muted = true; }
      if (el.volume > 0) { el.volume = 0; }
      if (el.defaultMuted !== true) { el.defaultMuted = true; }
    } catch (e) {}
  }
  function muteAll() {
    var list = document.querySelectorAll('video, audio');
    for (var i = 0; i < list.length; i++) { mute(list[i]); }
  }
  try {
    var proto = HTMLMediaElement.prototype;
    var oPlay = proto.play;
    proto.play = function () {
      var el = this;
      mute(el);
      var r = oPlay.apply(el, arguments);
      if (r && typeof r.then === 'function') {
        r.then(function () { mute(el); }, function () {});
      }
      return r;
    };
    var oLoad = proto.load;
    proto.load = function () {
      mute(this);
      return oLoad.apply(this, arguments);
    };
  } catch (e) {}
  if (window.MutationObserver) {
    try {
      var root = document.documentElement || document;
      new MutationObserver(function () { muteAll(); })
        .observe(root, { childList: true, subtree: true });
    } catch (e) {}
  }
  muteAll();
  return true;
})();`;

interface Props {
  url: string;
  onProgress: (progress: ScrapeProgress) => void;
  onResult: (payload: RawScrapePayload) => void;
  onError: (message: string) => void;
}

/**
 * 隐藏的 WebView，负责加载目标网页并抽取媒体资源。
 * 加载完成后会继续轮询等待懒加载资源，各阶段均有超时兜底。
 */
export default function ScrapeWebView({ url, onProgress, onResult, onError }: Props) {
  const webRef = useRef<WebView | null>(null);
  const callbacks = useRef({ onProgress, onResult, onError });
  callbacks.current = { onProgress, onResult, onError };

  // 站点的归属判定要用用户输入的地址，页面跳转后 location 就不再可信了
  const setupScript = useMemo(() => buildSetupScript(url), [url]);

  const beginExtractRef = useRef<() => void>(() => {});
  const startSettleRef = useRef<() => void>(() => {});
  const handleMessageRef = useRef<(event: WebViewMessageEvent) => void>(() => {});
  const handleNavigationRef = useRef<(navState: WebViewNavigation) => void>(() => {});
  const isDouyin = useMemo(() => {
    try {
      return matchAdapter(url)?.id === 'douyin';
    } catch {
      return false;
    }
  }, [url]);

  useEffect(() => {
    let disposed = false;
    let extractStarted = false;
    let finished = false;
    let settled = false;
    let stableCount = 0;
    let lastSignature = '';
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let interval: ReturnType<typeof setInterval> | null = null;

    const later = (fn: () => void, ms: number) => {
      timeouts.push(setTimeout(fn, ms));
    };

    const finishWithError = (message: string) => {
      if (finished || disposed) return;
      finished = true;
      callbacks.current.onError(message);
    };

    const beginExtract = () => {
      if (extractStarted || finished || disposed) return;
      extractStarted = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      callbacks.current.onProgress({
        phase: 'extracting',
        message: '正在解析页面中的图片与视频…',
      });
      // 兜底：极少数页面在注入脚本前发生跳转，这里补一次注入
      webRef.current?.injectJavaScript(setupScript);
      webRef.current?.injectJavaScript(EXTRACT_SCRIPT);
      later(() => {
        finishWithError('解析页面超时，请稍后重试');
      }, TIMING.EXTRACT_TIMEOUT);
    };

    const startSettle = () => {
      if (settled || finished || disposed) return;
      settled = true;
      let elapsed = 0;
      callbacks.current.onProgress({
        phase: 'waiting',
        message: '页面已加载，等待资源加载完成…',
      });
      const poll = () => {
        if (disposed || finished) return;
        webRef.current?.injectJavaScript(PROBE_STATE_SCRIPT);
      };
      poll();
      interval = setInterval(() => {
        if (disposed || finished) return;
        elapsed += TIMING.SETTLE_INTERVAL;
        poll();
        if (elapsed >= TIMING.SETTLE_TIMEOUT) {
          if (interval) clearInterval(interval);
          interval = null;
          beginExtract();
        }
      }, TIMING.SETTLE_INTERVAL);
    };

    handleMessageRef.current = (event: WebViewMessageEvent) => {
      if (disposed || finished) return;
      let data: any;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;

      if (data.__md === 'state' && data.payload) {
        const state = data.payload;
        const signature = `${state.ready}|${state.imgLoaded}/${state.imgTotal}`;
        stableCount = signature === lastSignature ? stableCount + 1 : 0;
        lastSignature = signature;
        const imageDone = state.imgTotal > 0 && state.imgLoaded >= state.imgTotal;
        const idle = state.ready === 'complete' && (imageDone || state.imgTotal === 0);
        if (idle) {
          beginExtract();
          return;
        }
        if (stableCount >= 4) {
          beginExtract();
          return;
        }
        if (state.imgTotal > 0) {
          callbacks.current.onProgress({
            phase: 'waiting',
            message: `等待图片加载完成 ${state.imgLoaded}/${state.imgTotal}`,
            ratio: state.imgLoaded / state.imgTotal,
          });
        }
        return;
      }

      if (data.__md === 'result') {
        finished = true;
        callbacks.current.onResult((data.payload || {}) as RawScrapePayload);
        return;
      }

      if (data.__md === 'error') {
        finishWithError(data.message || '解析页面失败');
      }
    };

    beginExtractRef.current = beginExtract;
    startSettleRef.current = startSettle;

    // 抖音风控处理：新 WebView 无 cookie 访问作品页会被 302 到首页/落地页
    // （只渲染出备案信息）。首次跳转的响应会下发 ttwid 等 cookie，
    // 检测到跳离作品页就把页面拉回用户输入的原始地址，通常二次加载即正常。
    let redirectCount = 0;
    handleNavigationRef.current = (navState: WebViewNavigation) => {
      if (disposed || finished || extractStarted || !isDouyin) return;
      const currentUrl = navState?.url;
      if (!currentUrl || isDouyinOkUrl(currentUrl)) return;
      redirectCount += 1;
      if (redirectCount > MAX_REDIRECT_RETRY) return;
      // 重置 settle 状态，让拉回后的 onLoadEnd 能重新进入等待逻辑
      settled = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      stableCount = 0;
      lastSignature = '';
      webRef.current?.loadUrl(url);
    };

    callbacks.current.onProgress({ phase: 'opening', message: '正在打开网页…' });

    // 兜底一：页面迟迟不触发 load 事件
    later(() => {
      if (disposed || extractStarted) return;
      callbacks.current.onProgress({
        phase: 'waiting',
        message: '加载超时，尝试解析已获取的内容…',
        degraded: true,
      });
      beginExtract();
    }, TIMING.LOAD_TIMEOUT);

    // 兜底二：整体耗时过长
    later(() => {
      finishWithError('抓取超时，请检查网址或网络后重试');
    }, TIMING.LOAD_TIMEOUT + TIMING.SETTLE_TIMEOUT + TIMING.EXTRACT_TIMEOUT + 5_000);

    return () => {
      disposed = true;
      timeouts.forEach(clearTimeout);
      if (interval) clearInterval(interval);
    };
  }, [url]);

  return (
    <View style={styles.hidden} pointerEvents="none">
      {/* 保持正常视口尺寸，避免 1x1 尺寸导致懒加载/IntersectionObserver 失效 */}
      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={styles.web}
        userAgent={DESKTOP_UA}
        injectedJavaScript={`${MUTE_MEDIA_SCRIPT}\n${setupScript}`}
        // 尽早注入：先静音，再挂采集脚本，让网络层嗅探覆盖到页面加载初期的媒体请求
        injectedJavaScriptBeforeContentLoaded={`${MUTE_MEDIA_SCRIPT}\n${setupScript}`}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mixedContentMode="always"
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        onLoadProgress={({ nativeEvent }) => {
          if (nativeEvent.progress > 0 && nativeEvent.progress < 1) {
            callbacks.current.onProgress({
              phase: 'opening',
              message: `正在加载网页 ${Math.round(nativeEvent.progress * 100)}%`,
              ratio: nativeEvent.progress,
            });
          }
        }}
        onLoadEnd={() => startSettleRef.current()}
        onMessage={event => handleMessageRef.current(event)}
        onNavigationStateChange={navState => handleNavigationRef.current(navState)}
        onError={() => callbacks.current.onError('网页加载失败，请检查网址或网络')}
        onHttpError={() => undefined}
      />
      {/* Android 上 WebView 走独立渲染层，父级 opacity 不会作用到它的内容上，
          因此改用一层不透明遮罩把它彻底盖住（不缩小视口，懒加载仍可正常触发）。 */}
      <View style={styles.cover} />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: -1,
    overflow: 'hidden',
  },
  web: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  cover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.bg,
  },
});
