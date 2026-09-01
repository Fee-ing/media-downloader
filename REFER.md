
---

# 一、如何识别网页中的视频资源

有三条通道，按优先级递进。

## 通道 A：网络层嗅探（主线，覆盖 90% 场景）

入口：`service-worker.js` 的 `chrome.webRequest.onResponseStarted`，监听
`{ urls: ["<all_urls>"], types: ["media","xmlhttprequest","object","other"] }`。

### 步骤

**A1. 暂存请求头**
`onBeforeSendHeaders` 按 `requestId` 把请求头存进内存 Map（响应阶段取出并删除）。目的是后续**复刻 Referer/Origin/Cookie 去下载**。

**A2. 排除自查回环**
请求头含 `x-original-request-id` → 丢弃（这是插件自己发的探测请求，防死循环）。

**A3. 合法性前置过滤**（任一命中即丢弃）

| 条件 | 说明 |
|---|---|
| URL / initiator 不以 `http` 开头，或无 initiator | 只认有发起页的请求 |
| initiator 主机以 `youtube.com` / `globo.com` 结尾 | 硬编码站点黑名单 |
| initiator 以 `OPTION.site`（`https://fetchv.net`）开头 | 排除自家页面 |
| `tabId === -1` | 回查「激活且 URL 包含 initiator」的标签页，找不到丢弃 |
| 响应头为空 / 状态码 ∉ [200, 300] | 只认成功响应 |
| 响应主机 SLD ∈ `[doppiocdn, adtng, afcdn, sacdnssedge]` | 广告 CDN 黑名单 |
| 响应主机 ∈ `OPTION.domain` | 用户自定义黑名单 |

**A4. 解析体积**
优先 `Content-Range: bytes 0-1023/2048` 取 `/` 后总数（同时标记 `isChunked`），否则 `Content-Length`；失败记 0。

**A5. 推断 Content-Type（核心）**
1. 取响应头 `content-type`，含 `;` 时只取第一段；
2. **无该头 → 按「请求类型 + URL 扩展名」猜**：`media`+`.mp4`→`video/mp4`，`media`+`.webm`→`video/webm`，`xhr`+`.m3u8`→`application/vnd.apple.mpegurl`；仍猜不出则丢弃；
3. **文本型 XHR 升格为 HLS**：若 `type==='xmlhttprequest'` + `documentId` 已注册 + `GET` + MIME 属 `text/*` / JSON / XML / JS，且（URL 命中 `google-analytics|doubleclick|…` 正则 **或** 通道 B 的文本探测确认为 `#EXTM3U`）→ 强制改写为 `application/vnd.apple.mpegurl`。

**A6. 解析文件名**
`Content-Disposition` 的 `filename=` → 否则 URL 末段 → `media` 类型且为空补 `undefined.mp4` → 兜底 `no-filename`。

**A7. 解析格式（扩展名）**
- `master.txt` + `text/plain` → 直接 `m3u8`；
- 否则查 `MIME→扩展名` 映射表：`general` 表直接映射；`application/octet-stream` / `binary/octet-stream` 属 `stream` 表，**必须 URL 自带已知扩展名才认**（防止把任意二进制当成视频）；
- 表里都没有 → 看 URL 扩展名是否在白名单内。

**A8. 兜底：回问页面（通道 B 的第二种能力）**
格式仍为空 **且** 是 `xhr` **且** 带 `Content-Range`（分片传输）→ 向 `injection.js` 发 `CHECK_VIDEO_SRC`，遍历 `document.querySelectorAll('video')`（含内部 `<source>`），跳过 `blob:` 源、相对路径用 `new URL(src, document.URL)` 补全后与目标 URL 全等比对 → 命中判 `mp4`。

**A9. 终审入库**
- 格式必须在白名单 `m3u8/m3u/mp4/3gp/flv/mov/avi/wmv/webm/f4v/acc/mkv/mp3/wav/ogg`；
- `m3u8/m3u` → `type='hls'`，**跳过体积校验**；其余要求 `size > 0` 且落在 `[size.min, size.max]` 内（默认 min=500KB，配置单位 KB，运行时 ×1024）；
- 每标签页上限 30 条、按 URL 去重；
- 只保留 `range/content-length/content-type/accept-encoding/accept/accept-language` **之外**的请求头（即留住 Referer/Origin/Cookie）；
- 写入 `storage{tabId}` 并 `setBadgeText` 更新角标。

## 通道 B：页面探测（补齐「嗅探不到」的场景）

针对 **隐藏在 iframe 里**、**被 JS 加密参数**、**m3u8 以 `text/plain` 返回** 的情况。

**B1. 注入注册**
`injection.js` 启动时读 `localStorage['fv_inject']`（结构 `{top, blob, at, hit}`），若有效则向 SW 发 `INJECT_STORAGE_REGISTER`，SW 记录 `documentId`——**只有注册过的文档才会走 A5-3 的文本探测**，避免全网乱抓。

**B2. iframe 协同（跨帧「接力」）**
- 顶层帧执行 `seedConfigStorage()`：检测 `video[src^="blob:"]`，把 `{top, blob}` 写进 `localStorage`；
- 子帧执行 `detectBlobVideo(topInject)`：若自己是 iframe、页面里有 blob 视频、但顶层未注入 → 写入配置并 `location.reload()`，让顶层帧重新初始化；
- `availability()` 用 `at`（写入时间）/ `hit`（命中时间）做 TTL：30 分钟内有效，命中后宽限 7 天，过期自动清理字段。

**B3. 文本探测（确认隐形 m3u8）**
`CHECK_TEXT_CONTENT`：在**页面上下文**用原始请求头重放 `fetch(url)`（带 `credentials:'include'`、追加 `X-Original-Request-Id`、10s 超时），响应文本 `trim().startsWith('#EXTM3U')` 即认定为 HLS 播放列表，结果写回 `localStorage` 做缓存。

**B4. 弹窗侧的引导**
弹窗打开时依次发 `DETECT_INJECT_STORAGE`（顶层帧）→ `DETECT_BLOB_VIDEO`，若发现「页面有 blob 视频但能力未开启」，就露出「注入捕获」开关；用户打开后发 `INJECT_CAPTURE` → 2s 后 `chrome.tabs.reload()` 重载生效。

## 通道 C：主动录制（彻底抓不到时的兜底）

当列表为空时，弹窗用 `chrome.scripting.executeScript({allFrames:true})` 扫描可录制视频：

```js
// 条件：非静音 (muted === false) 且
//   video.srcObject 存在，或
//   video.src 以 blob: 开头，或
//   子 <source> 中存在 blob: 源
// live = !isFinite(video.duration)
```

结果为空 → 提示「检测不到可录制的视频，请检查是否处于静音状态」。
单一结果且为直播 → `quickStart=true` 免确认；否则弹出选择浮层（可设起止时间 + 录制模式），模式可**按域名记忆**存进 `OPTION.recMode`。

---

# 二、如何播放

播放**只在弹窗内做预览**（`popup.js` 的 `player()`），用于「先确认是不是想要的视频」。

## 步骤

**P1. 构造播放器**
`itemCreate` 里点 ▶ → 收起其他条目 → `player(item, $player, $resolution)` → 动态创建 `<video autoplay controls>` 插入折叠区。

**P2. 准备请求头改写规则**

```js
creatRules(headers)   // 仅当抓取到的请求头里含 origin/referer 才生成规则，否则返回 null
```
→ 生成 DNR `modifyHeaders` 规则（把原始 Referer/Origin 补回去，解决防盗链）。

**P3. 安装临时会话规则**

```js
ruleId = 1
condition = {
  domainType: "thirdParty",
  resourceTypes: ["xmlhttprequest", "media"],
  tabIds: [-1]              // 关键：只作用于「非标签页发起」的请求，即弹窗自己发出的
}
action = { type: "modifyHeaders", requestHeaders }
```
`tabIds: -1` 是精髓——**只给弹窗自己的播放请求加 Referer，不污染原网页**。
规则经 SW 的 `SET_RULES` 注册；弹窗关闭时 `chrome.runtime.onConnect('POPUP').onDisconnect` 自动 `removeRuleIds:[1]`。

**P4. HLS 播放路径（`type === 'hls'`）**
用打包的 hls.js（`js/hls-player.js`，506KB）：

```js
const hls = new Hls({ autoStartLoad: false });   // 先不加载，等规则装好
```
1. `setRules()` 先针对 **m3u8 主域名** 装上规则 → `hls.loadSource(url)`；
2. `MANIFEST_PARSED`：从 `levels[].uri` 与 `audioTracks[].url` 取**顶级域名**，发现新域名就扩容 `requestDomains` 并重建规则（Chrome ≥101 用 `requestDomains`，否则降级为 `regexFilter`）；
3. `LEVEL_LOADED` / `AUDIO_TRACK_LOADED`：再从 `details.fragments[].url` 继续补域名（多级 m3u8 才暴露出真实 ts 域名）；
4. 有音轨但 `hls.media` 未挂 → `attachMedia(video)`；
5. `hls.startLoad()` 真正开始拉流；
6. **分辨率显示**：在 `levels` 中选 `bitrate` 最大且有 `width/height` 的档位显示 `W x H`；
7. `DESTROYING` 事件里移除规则。

**P5. 普通文件播放路径**
- 有规则 → `setRules(rules, item.url).then(() => video.src = url)`；
- 无规则 → 直接 `video.src = url`；
- `loadedmetadata` 后写入 `videoWidth x videoHeight` 到分辨率位和 `item.quality`。

**P6. 关闭清理**
折叠区 `hide.bs.collapse` → `hls.destroy()` + 移除 `<video>`，`DESTROYING` 回调里摘掉 DNR 规则。

> 注：若 `Hls.isSupported()` 为假（如 iOS Safari 内核），HLS 条目不会降级播放，直接无画面。

---

# 三、如何下载

## 3.1 直链 / HLS 下载：交接给官网页面

### 步骤

**D1. 点击下载按钮**
```js
// audio/* → 直接新开标签页让浏览器原生处理
if (item.contentType.startsWith('audio')) chrome.tabs.create({ url: item.url });
```

**D2. 去重**
读 `storage.local.tasks=[{tabId, url}]`，若当前窗口已有「fetchv.net 页面且 url 相同」的下载任务 → 直接 `chrome.tabs.update(tabId, {active:true})` 复用，不重复开页。

**D3. 写交接数据**
```js
chrome.storage.local.set({ queue: {
  ...item,                    // url / headers / method / format / contentType / name / size / type
  initiator: tab.url,
  title: tab.title || tab.url,
  tabId, tabsCount, version
}});
```

**D4. 打开对应下载页**

| 资源 type | 页面 |
|---|---|
| `hls` | `https://fetchv.net/{lang}/m3u8downloader` |
| 其他 | `https://fetchv.net/{lang}/videodownloader` |
| `rec` | `https://fetchv.net/{lang}/bufferrecorder` |

语言目录由 `chrome.i18n.getUILanguage()` 映射；`zh-CN` 且非移动端时走 `router.html?path=/xxx`（`router.js` 用 `<a>` 点击做跳转，规避直连限制）。

**D5. 官网页面接手（插件侧桥接）**
`js/content.js` 在下载页 `document_end` 执行：
1. 取走并删除 `storage.local.queue`；
2. 通过 `BroadcastChannel('fetchv-temporary-channel')` 把整个 payload 推给页面脚本；
3. 非 `rec` 类型时把 `{tabId, url}` 追加进 `tasks`；
4. 建立 `BroadcastChannel('channel-{currentTabId}')` 长连接，响应页面后续调用。

**D6. 页面可调用的桥接 API**

| 消息 | 作用 | 链路 |
|---|---|---|
| `GET_ALL_STORAGE {storageKey}` | 拿该标签页**全部**嗅探到的资源（不只是点击的那条） | content → `storage.local` |
| `BG_FETCH {url, headers, method}` | 带原始请求头 + Cookie 的跨源抓取（m3u8/ts 分片、防盗链资源） | 页面 → content → SW → **offscreen** → `fetch(mode:'cors', credentials:'include')` → Blob → `blobURL` → content 再 `fetch` 成 `ArrayBuffer` → 回传页面 |
| `REC_ON_DATA` / `REC_STOP` / `REC_ERROR` | 录制数据流 | 见 3.2 |

Offscreen 抓取带 20s 超时 `AbortController`；offscreen 文档以 `Reason.BLOBS` 创建（`i()` 单例化），创建失败则整个下载页拿不到数据。

## 3.2 录制下载（`bufferrecorder`）

弹窗点「录制」→ `createTab({targetTab, type:'rec', mode, quickStart}, true)` → 打开 bufferrecorder 页 → 插件侧开始推流。

### 模式一：`msr`（MediaStream 实时转码，默认用于点播）

1. `injection.js` 的录制器类扫描当前页 `video` 元素（同通道 C 规则），多视频时在每个视频上弹浮层让用户选，可指定**起止时间**（`stringToTime` 解析 `HH:MM:SS`）；
2. 若指定了起始时间：`pause()` → `currentTime = start` → `play()`，并监听 `playing` 事件确认 seek 完成；
3. `video.captureStream()` 取流，动态 `import('./mediabunny.js')`；
4. 编码参数：
   - 视频：`getVideoBitrate(w, h, fps, quality) = 0.07 × w × h × fps × {low:0.7, medium:1, high:1.5}`，钳制在 `[500k, 20M]`，codec 优先级 `avc → vp8 → hevc → vp9 → av1`；
   - 音频：128kbps，codec 优先级 `aac → opus → mp3 → vorbis`；
5. `new Output({ target: NullTarget, format: new Mp4OutputFormat({ fastStart:'fragmented', minimumFragmentDuration:3 }) })`，回调：
   - `onFtyp` 暂存 ftyp → `onMoov` 时与 moov 拼接成 **header Blob** → `createObjectURL` → `REC_ON_DATA {type:'header', quality}`；
   - `onMoof`+`onMdat` → 拼接成 **segment Blob** → `REC_ON_DATA {type:'segment', lastMoofTimestamp, lastMoofDuration, quality}`；
   - 到达设定结束时间 → 自动 `stop()`；
6. 数据通路：`REC_ON_DATA` → SW → `chrome.tabs.sendMessage(recorderTab)` → `content.js` → `fetch(blobURL)` → ArrayBuffer → `BroadcastChannel` 推给官网页面组装；
7. 视频播完（`ended`）或用户停止 → `output.finalize()` → 带 `onended:true` 的最后一帧通知页面收尾。

### 模式二：`mse`（Hook MSE 缓冲，用于 blob 加密流 / 直播）

1. `seedRecorderTabId(tabId)` → 写 `localStorage['fv_recorder_tab']`（5s 后自动清除）→ `location.reload()`；
2. 重载后 `injection.js` 读到该 key，把 `js/hook.js` 以 `<script src="chrome-extension://.../js/hook.js">` 注入**页面主世界**；
3. `hook.js` 三层 Proxy：
   - `MediaSource` 构造 → 记录 `mid`，监听 `sourceended` 后延时通知页面收尾；
   - `addSourceBuffer` → 记录 mime 与 `bid`；
   - **`appendBuffer`** → 把每次追加的 ArrayBuffer 包成 `Blob` → `createObjectURL` → `BroadcastChannel('channel-{tabId}').postMessage({url, mime, mid, bid, live})`，10s 后 `revokeObjectURL`；
4. 另有一段 `HTMLMediaElement.prototype.currentTime` 的 setter Hook：首次设置时**强制归零**（部分站点用 seek 做反录/水印，这里绕过；10s 后失效）；
5. `injection.js` 的 `BroadcastChannel` 监听器把 `{url, mimetype}` 转成 `REC_ON_DATA` 发给 SW，之后走与 msr 完全相同的通路；
6. 同时监听 `REC_STOP` 置 `e=true`，停止截获。

### 录制期间的辅助能力
- **倍速**：`REC_SPEED_UP` → `injection.js` 遍历 `video[src^="blob:"]` 设 `playbackRate`；
- **角标动画**：页面注入 `<div>` + `img/recording.svg` 录制中角标；
- **错误上报**：`REC_ERROR {fatal, message}`，`fatal = outputChunksCount < 1 || video.ended`；
- **重启**：`REC_RESTART` → 重置计数器后 `createRecorder()`。

---

# 四、数据与生命周期

| 存储 | 内容 | 清理时机 |
|---|---|---|
| `storage.local['storage{tabId}']` | 该标签页嗅探到的资源表（最多 30 条） | 标签页关闭 / 导航 `loading` 时删除 |
| `storage.local['queue']` | 交给下载页的交接数据 | `content.js` 读走后立即删除 |
| `storage.local['tasks']` | 已开下载页 `{tabId, url}` | SW 启动时剔除失效项 |
| `storage.sync['options']` | `size.min/max`、`domain[]`、`recMode[]`、`noAddDomainTip` | 持久 |
| `localStorage['fv_inject']` | 页面注入能力标记 + TTL | 30 分钟未命中失效 |
| `localStorage['fv_recorder_tab']` | MSE 录制的录制端 tabId | 写入 5s 后自动清除 |

SW 启动时还会做两件清理：把非 `storage*` 的遗留键清掉；扫描 DNR session 规则，删掉已不存在标签页的孤儿规则。

---

# 五、端到端时序小结

```
网页发起媒体请求
   ↓ onBeforeSendHeaders       暂存请求头
   ↓ onResponseStarted
      过滤 → 体积 → MIME → 文件名 → 格式 → [回问页面] → 大小/白名单
   ↓ 命中
storage{tabId} + 角标+1
   ↓
┌──弹窗列表──────────────────────────────────────┐
│ ▶ 播放：video/hls.js + DNR 补 Referer(tabIds:-1)│
│ ⬇ 下载：queue → fetchv.net 下载页              │
│         ↕ BroadcastChannel：GET_ALL_STORAGE     │
│                             BG_FETCH→offscreen  │
│ ● 录制：MSR(captureStream+mediabunny fMP4)      │
│         或 MSE(hook appendBuffer)  → REC_ON_DATA│
└────────────────────────────────────────────────┘
```

**一句话概括**：网络层用 `webRequest` 抓 `media/xhr/object/other` 响应，经「黑名单 → 体积 → MIME 推断 → 格式映射 → 大小白名单」五道筛子定资源，两处存疑时（隐形 m3u8、分片 XHR）回问内容脚本；播放走弹窗内 `video`/hls.js 并用 DNR 会话规则（限定 `tabIds:[-1]`）补防盗链头；下载则把「资源条目 + 原始请求头」交接给官网页面，由插件提供 `BG_FETCH`（offscreen 带 Cookie 跨源抓取）和录制推流（`captureStream` 编码 或 Hook `appendBuffer`）两条供料通道。