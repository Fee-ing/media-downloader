/**
 * 浏览器插件式爬虫：像 Chrome 扩展一样注入采集脚本
 *
 * 核心优势：
 * 1. 可见的 WebView，模拟真实浏览器行为
 * 2. 内容脚本（Content Script）注入，不暴露自动化特征
 * 3. 完整的页面加载流程，支持所有 JS 渲染
 * 4. 可手动干预（刷新、后退、修改 URL）
 * 5. 自动处理重定向，用户可见
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  WebView,
  type WebViewNavigation,
  type WebViewMessageEvent,
} from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { COLORS, DESKTOP_UA, GAP, PAGE_PADDING, TIMING } from '../constants';
import {
  EXTRACT_SCRIPT,
  PROBE_STATE_SCRIPT,
  buildSetupScript,
} from '../services/extractor';
import { matchAdapter } from '../services/sites';
import type { RawScrapePayload, ScrapeProgress } from '../types';

// ============================================================
// Stealth 脚本：隐藏自动化特征
// ============================================================

const STEALTH_SCRIPT = `(function () {
  // 1. 隐藏 navigator.webdriver
  if (typeof navigator !== 'undefined' && 'webdriver' in navigator) {
    try {
      delete (navigator as any).webdriver;
    } catch (e) {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    }
  }

  // 2. 修复 Chrome 对象
  if (typeof window.chrome === 'undefined') {
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };
  }

  // 3. 模拟真实 plugins
  if (typeof navigator !== 'undefined') {
    const fakePlugins = {
      length: 2,
      item: function(index: number) { return null; },
      namedItem: function(name: string) { return null; },
      [Symbol.iterator]: function*() {
        yield {
          filename: 'mhndoc.dll',
          description: 'Microsoft Document Imaging',
          name: 'NDoc Document Converter',
        };
        yield {
          filename: 'np-pdf.dll',
          description: 'PDF',
          name: 'PDF Plugin',
        };
      }
    };
    try {
      Object.defineProperty(navigator, 'plugins', {
        get: () => fakePlugins,
        configurable: true,
      });
    } catch (e) {}
  }

  // 4. 模拟真实 languages
  if (typeof navigator !== 'undefined') {
    try {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true,
      });
    } catch (e) {}
  }

  // 5. 修复 vendor
  if (typeof navigator !== 'undefined') {
    try {
      Object.defineProperty(navigator, 'vendor', {
        get: () => 'Google Inc.',
        configurable: true,
      });
    } catch (e) {}
  }

  // 6. 修复 performance
  try {
    const originalObserver = PerformanceObserver.prototype.observe;
    PerformanceObserver.prototype.observe = function(config) {
      return originalObserver.call(this, config);
    };
  } catch (e) {}

  // 7. 修复 permissions
  if (typeof PermissionState !== 'undefined') {
    try {
      const originalQuery = (navigator as any).permissions?.query;
      if (originalQuery) {
        (navigator as any).permissions.query = function(descriptor) {
          if (descriptor.name === 'notifications') {
            return Promise.resolve({ state: PermissionState.DENIED, onchange: null });
          }
          return originalQuery.call(this, descriptor);
        };
      }
    } catch (e) {}
  }

  return true;
})();`;

/**
 * 媒体静音脚本（加载网页时静音）。
 *
 * 覆盖场景：
 * 1. <video>/<audio>：拦截 play/load，播放前强制 muted + volume 0
 * 2. WebAudio：AudioContext 创建的 Source/Oscillator 在 start 后断连，避免出声
 * 3. Shadow DOM / 同源 iframe：递归遍历静音
 * 4. 轮询兜底：页面脚本反复取消静音时也能按住
 */
const MUTE_MEDIA_SCRIPT = `(function () {
  if (window.__MD_MUTE__) { return true; }
  window.__MD_MUTE__ = true;

  function mute(el) {
    try {
      if (!el.muted) { el.muted = true; }
      if (el.volume > 0) { el.volume = 0; }
      if (el.defaultMuted !== true) { el.defaultMuted = true; }
      el.setAttribute('muted', '');
    } catch (e) {}
  }

  function walk(root) {
    if (!root || !root.querySelectorAll) return;
    var medias = root.querySelectorAll('video, audio');
    for (var i = 0; i < medias.length; i++) { mute(medias[i]); }
    // 穿透 open Shadow DOM
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var sr = all[j].shadowRoot;
      if (sr) { walk(sr); }
    }
  }

  function muteAll() {
    try { walk(document); } catch (e) {}
    // 同源 iframe
    var frames = document.querySelectorAll('iframe');
    for (var k = 0; k < frames.length; k++) {
      try {
        var doc = frames[k].contentDocument;
        if (doc) { walk(doc); }
      } catch (e) {}
    }
  }

  // 1. 拦截 HTMLMediaElement.play / load，自动播放前强制静音
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

  // 2. 拦截 WebAudio：Source/Oscillator 在 start 后断连，不输出到扬声器
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      var nodes = ['createBufferSource', 'createOscillator', 'createMediaStreamSource'];
      for (var m = 0; m < nodes.length; m++) {
        (function (method) {
          if (!AC.prototype[method]) return;
          var orig = AC.prototype[method];
          AC.prototype[method] = function () {
            var node = orig.apply(this, arguments);
            try {
              var oStart = node.start;
              node.start = function () {
                var r = oStart.apply(node, arguments);
                setTimeout(function () {
                  try { node.disconnect(); } catch (e2) {}
                }, 0);
                return r;
              };
            } catch (e2) {}
            return node;
          };
        })(nodes[m]);
      }
    }
  } catch (e) {}

  // 3. 监听 DOM 变化，新增的媒体立即静音
  if (window.MutationObserver) {
    try {
      var root = document.documentElement || document;
      new MutationObserver(function () { muteAll(); })
        .observe(root, { childList: true, subtree: true });
    } catch (e) {}
  }

  // 4. 轮询兜底：页面脚本反复取消静音也能按住
  try {
    window.setInterval(function () {
      if (!window.__MD_MUTE__) return;
      muteAll();
    }, 800);
  } catch (e) {}

  muteAll();
  return true;
})();`;

// ============================================================
// 工具函数
// ============================================================

const DOUYIN_OK_HOST = /(^|\.)(douyin|iesdouyin)\.com$/i;
const DOUYIN_OK_PATH = /^\/(video|note|share\/video|share\/note)\/\d{6,}/;

function isDouyinOkUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return DOUYIN_OK_HOST.test(parsed.hostname) && DOUYIN_OK_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

// ============================================================
// 组件状态
// ============================================================

interface WebViewState {
  url: string;
  title: string;
  progress: number;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  finalUrl: string; // 实际加载的 URL（可能因重定向而变化）
}

interface Props {
  url: string;
  onProgress: (progress: ScrapeProgress) => void;
  onResult: (payload: RawScrapePayload) => void;
  onError: (message: string) => void;
  /** 用户点击停止抓取按钮时回调 */
  onStop?: () => void;
}

export default function BrowserStyleWebView({
  url,
  onProgress,
  onResult,
  onError,
  onStop,
}: Props) {
  const webRef = useRef<WebView | null>(null);
  const [webViewState, setWebViewState] = useState<WebViewState>({
    url: url,
    title: '',
    progress: 0,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    finalUrl: url,
  });
  // 采集状态
  const extractStartedRef = useRef(false);
  const finishedRef = useRef(false);
  const settledRef = useRef(false);
  const stableCountRef = useRef(0);
  const lastSignatureRef = useRef('');
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const redirectChainRef = useRef<string[]>([]);
  const currentUrlRef = useRef(url);

  // 抖音风控计数
  const redirectCountRef = useRef(0);
  const isDouyin = useMemo(() => {
    try {
      return matchAdapter(url)?.id === 'douyin';
    } catch {
      return false;
    }
  }, [url]);

  // 构建注入脚本
  const setupScript = useMemo(() => buildSetupScript(url), [url]);

  // 清理定时器
  const clearAllTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // 添加定时器
  const addTimeout = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timeoutsRef.current.push(t);
    return t;
  }, []);

  // 开始采集
  const beginExtract = useCallback(() => {
    if (extractStartedRef.current || finishedRef.current) return;
    extractStartedRef.current = true;

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    onProgress({
      phase: 'extracting',
      message: '正在解析页面中的图片与视频…',
    });

    webRef.current?.injectJavaScript(setupScript);
    webRef.current?.injectJavaScript(EXTRACT_SCRIPT);

    addTimeout(() => {
      if (finishedRef.current) return;
      onError('解析页面超时，请稍后重试');
    }, TIMING.EXTRACT_TIMEOUT);
  }, [setupScript, addTimeout, onProgress, onError]);

  // 开始等待资源加载
  const startSettle = useCallback(() => {
    if (settledRef.current || finishedRef.current) return;
    settledRef.current = true;

    let elapsed = 0;
    onProgress({
      phase: 'waiting',
      message: '页面已加载，等待资源加载完成…',
    });

    const poll = () => {
      if (finishedRef.current) return;
      webRef.current?.injectJavaScript(PROBE_STATE_SCRIPT);
    };

    poll();
    intervalRef.current = setInterval(() => {
      if (finishedRef.current) return;
      elapsed += TIMING.SETTLE_INTERVAL;
      poll();

      if (elapsed >= TIMING.SETTLE_TIMEOUT) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        beginExtract();
      }
    }, TIMING.SETTLE_INTERVAL);
  }, [beginExtract, onProgress]);

  // 处理消息
  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (finishedRef.current) return;

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
      stableCountRef.current = signature === lastSignatureRef.current ? stableCountRef.current + 1 : 0;
      lastSignatureRef.current = signature;

      const imageDone = state.imgTotal > 0 && state.imgLoaded >= state.imgTotal;
      const idle = state.ready === 'complete' && (imageDone || state.imgTotal === 0);

      if (idle) {
        beginExtract();
        return;
      }

      if (stableCountRef.current >= 4) {
        beginExtract();
        return;
      }

      if (state.imgTotal > 0) {
        onProgress({
          phase: 'waiting',
          message: `等待图片加载完成 ${state.imgLoaded}/${state.imgTotal}`,
          ratio: state.imgLoaded / state.imgTotal,
        });
      }
      return;
    }

    if (data.__md === 'result') {
      finishedRef.current = true;
      clearAllTimeouts();
      onResult(data.payload || {});
      return;
    }

    if (data.__md === 'error') {
      onError(data.message || '解析页面失败');
    }
  }, [beginExtract, onProgress, onResult, onError]);

  // 处理请求拦截
  const handleShouldStartLoadWithRequest = useCallback((request: WebViewNavigation) => {
    const { url: requestUrl, navigationType } = request;

    // ✅ 1. 允许首次加载（避免白屏）
    if (!currentUrlRef.current || requestUrl === currentUrlRef.current) {
      return true;
    }

    // ✅ 2. 允许用户主动点击链接产生的导航（可选，看业务需求）
    // navigationType: 'click' | 'formsubmit' | 'backforward' | 'reload' | 'formresubmit' | 'other'
    // 'other' 通常包含 JS 重定向和 meta refresh
    if (navigationType === 'click' || navigationType === 'formsubmit') {
      currentUrlRef.current = requestUrl;
      redirectChainRef.current.push(requestUrl);
      return true;
    }

    onProgress({ phase: 'waiting', message: `已阻止重定向到 ${requestUrl}` });

    return false;
  }, [onProgress]);

  // 处理导航状态变化
  const handleNavigationStateChange = useCallback((navState: WebViewNavigation) => {
    if (finishedRef.current || extractStartedRef.current) return;

    const currentUrl = navState?.url || '';
    currentUrlRef.current = currentUrl;

    // 更新 UI 状态
    setWebViewState(prev => ({
      ...prev,
      url: currentUrl,
      finalUrl: currentUrl,
      canGoBack: navState?.canGoBack || false,
      canGoForward: navState?.canGoForward || false,
      title: navState?.title || prev.title,
    }));

    // 抖音风控处理
    if (isDouyin) {
      if (!isDouyinOkUrl(currentUrl)) {
        redirectCountRef.current += 1;
        if (redirectCountRef.current > 3) {
          onError('检测到异常重定向，可能已被风控');
          return;
        }

        settledRef.current = false;
        stableCountRef.current = 0;
        lastSignatureRef.current = '';

        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }

        // iOS 上 WebView 实例无 loadUrl 方法，通过更新 state 的 url（驱动 source）重新加载
        currentUrlRef.current = url;
        setWebViewState(prev => ({ ...prev, url, finalUrl: url, loading: true, progress: 0 }));
        return;
      }
    }

    // 页面加载完成
    if (navState.navigationType === 'reload' || navState.navigationType === 'other') {
      extractStartedRef.current = false;
      finishedRef.current = false;
      settledRef.current = false;
      redirectCountRef.current = 0;
      stableCountRef.current = 0;
      lastSignatureRef.current = '';
    }
  }, [isDouyin, url, onError]);

  // 处理加载进度
  const handleLoadProgress = useCallback((event: { nativeEvent: { progress: number } }) => {
    const progress = event.nativeEvent.progress;
    if (progress > 0 && progress < 1) {
      setWebViewState(prev => ({ ...prev, progress, loading: true }));
      onProgress({
        phase: 'opening',
        message: `正在加载网页 ${Math.round(progress * 100)}%`,
        ratio: progress,
      });
    }
  }, [onProgress]);

  // 处理加载结束
  const handleLoadEnd = useCallback(() => {
    setWebViewState(prev => ({ ...prev, loading: false, progress: 1 }));
    // 页面加载完成后再次强制静音，覆盖页面脚本在加载过程中重置音量的情况
    webRef.current?.injectJavaScript(MUTE_MEDIA_SCRIPT);
    startSettle();
  }, [startSettle]);

  // 处理加载错误
  const handleError = useCallback(() => {
    onError('网页加载失败，请检查网址或网络');
  }, [onError]);

  // 超时处理
  useEffect(() => {
    let disposed = false;

    addTimeout(() => {
      if (disposed || extractStartedRef.current) return;
      onProgress({
        phase: 'waiting',
        message: '加载超时，尝试解析已获取的内容…',
        degraded: true,
      });
      beginExtract();
    }, TIMING.LOAD_TIMEOUT);

    addTimeout(() => {
      if (disposed) return;
      onError('抓取超时，请检查网址或网络后重试');
    }, TIMING.LOAD_TIMEOUT + TIMING.SETTLE_TIMEOUT + TIMING.EXTRACT_TIMEOUT + 5_000);

    return () => {
      disposed = true;
      clearAllTimeouts();
    };
  }, [addTimeout, beginExtract, clearAllTimeouts, onProgress, onError]);

  // 导航操作
  const handleGoBack = useCallback(() => {
    webRef.current?.goBack();
  }, []);

  // 刷新后重置采集状态
  const handleReloadAndReset = useCallback(() => {
    extractStartedRef.current = false;
    finishedRef.current = false;
    settledRef.current = false;
    redirectCountRef.current = 0;
    stableCountRef.current = 0;
    lastSignatureRef.current = '';
    redirectChainRef.current = [];

    webRef.current?.reload();
  }, []);

  const handleGoForward = useCallback(() => {
    webRef.current?.goForward();
  }, []);

  const handleManualExtract = useCallback(() => {
    extractStartedRef.current = false;
    finishedRef.current = false;
    settledRef.current = false;

    webRef.current?.injectJavaScript(setupScript);
    webRef.current?.injectJavaScript(EXTRACT_SCRIPT);
  }, [setupScript]);

  const handleStop = useCallback(() => {
    finishedRef.current = true;
    extractStartedRef.current = false;
    settledRef.current = false;
    clearAllTimeouts();
    onStop?.();
  }, [clearAllTimeouts, onStop]);

  return (
    <View style={styles.container}>
      {/* 浏览器工具栏（无地址栏）：左侧导航，右侧操作 */}
      {/* <View style={styles.navBar}>
        <View style={styles.navButtons}>
          <TouchableOpacity
            style={[styles.navBtn, !webViewState.canGoBack && styles.navBtnDisabled]}
            onPress={handleGoBack}
            disabled={!webViewState.canGoBack}
          >
            <Ionicons name="chevron-back" size={20} color={webViewState.canGoBack ? COLORS.text : COLORS.sub2} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.navBtn, !webViewState.canGoForward && styles.navBtnDisabled]}
            onPress={handleGoForward}
            disabled={!webViewState.canGoForward}
          >
            <Ionicons name="chevron-forward" size={20} color={webViewState.canGoForward ? COLORS.text : COLORS.sub2} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.navBtn} onPress={handleReloadAndReset}>
            <Ionicons name="refresh" size={20} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.navButtons}>
          <TouchableOpacity style={styles.navBtn} onPress={handleManualExtract} disabled={finishedRef.current}>
            <Ionicons name="download-outline" size={20} color={finishedRef.current ? COLORS.sub2 : COLORS.primary} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.navBtn} onPress={handleStop}>
            <Ionicons name="close-circle" size={20} color={COLORS.danger} />
          </TouchableOpacity>
        </View>
      </View> */}

      {/* 加载进度条 */}
      {webViewState.loading && (
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${webViewState.progress * 100}%` }]} />
          </View>
        </View>
      )}

      {/* 当前 URL 状态提示 */}
      {!webViewState.loading && (
        <View style={styles.statusBar}>
          <Ionicons name="checkmark-circle" size={16} color={COLORS.success} />
          <Text style={styles.statusText} numberOfLines={1}>
            {webViewState.title || webViewState.finalUrl}
          </Text>
        </View>
      )}

      {/* WebView */}
      <WebView
        ref={webRef}
        source={{ uri: webViewState.url }}
        style={styles.webview}
        automaticallyAdjustContentInsets={false}
        contentMode="desktop"
        userAgent={DESKTOP_UA}
        injectedJavaScript={`${STEALTH_SCRIPT}\n${MUTE_MEDIA_SCRIPT}\n${setupScript}`}
        injectedJavaScriptBeforeContentLoaded={`${STEALTH_SCRIPT}\n${MUTE_MEDIA_SCRIPT}`}
        javaScriptEnabled
        domStorageEnabled
        cacheEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mixedContentMode="always"
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        onLoadProgress={handleLoadProgress}
        onLoadEnd={handleLoadEnd}
        onMessage={event => handleMessage(event)}
        onNavigationStateChange={handleNavigationStateChange}
        onError={handleError}
        onHttpError={handleError}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: PAGE_PADDING,
    paddingVertical: 8,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: GAP,
  },
  navButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  navBtn: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: COLORS.surface2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navBtnDisabled: {
    opacity: 0.4,
  },
  progressContainer: {
    height: 2,
    backgroundColor: COLORS.surface,
  },
  progressBar: {
    flex: 1,
    backgroundColor: COLORS.surface2,
  },
  progressFill: {
    height: 1,
    backgroundColor: COLORS.primary,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: PAGE_PADDING,
    paddingVertical: 6,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 6,
  },
  statusText: {
    flex: 1,
    color: COLORS.sub,
    fontSize: 12,
  },
  webview: {
    flex: 1,
    backgroundColor: '#fff',
  },
});

// 导出类型供外部使用

