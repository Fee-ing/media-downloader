# Media Downloader

一个基于 React Native（Expo）的跨平台媒体抓取与下载工具。它内置一个「浏览器式」的 `WebView`，像 Chrome 扩展的内容脚本（Content Script）一样注入采集逻辑，从任意网页中嗅探、解析并下载图片与视频资源。

## 测试安装教程

### 环境要求
- **Node.js**：建议 18 LTS 或更高版本
- **npm** 或 **yarn** 包管理器
- **Expo CLI**：`npm install -g expo-cli`
- 一台用于测试的手机：
  - **iOS**：需安装 [Expo Go](https://expo.dev/go)（App Store），或使用 EAS Build 构建 dev 客户端
  - **Android**：需安装 [Expo Go](https://expo.dev/go)（Google Play / APK），或开启开发者模式 + USB 调试

### 步骤一：克隆并安装依赖
```bash
git clone <your-repo-url> media-downloader
cd media-downloader
npm install          # 或 yarn install
```

### 步骤二：启动开发服务器
```bash
npm start            # 等价于 npx expo start
```
启动后会显示一个二维码（QR code）与若干选项：
- 按 `a` 在已连接的 Android 设备 / 模拟器上打开
- 按 `i` 在 iOS 模拟器上打开
- 用手机上的 **Expo Go** 扫描终端里的二维码直接运行

### 步骤三：在手机上运行（最常用）
1. 手机与电脑处于同一局域网。
2. 手机打开 Expo Go，点击「Scan QR code」。
3. 扫描终端二维码，应用即会加载到手机上。

### 步骤四：构建独立测试包（可选，更接近生产）
使用 EAS Build 生成可安装的 dev / preview 包：
```bash
# 首次使用需登录 Expo 账号
npx eas login

# 构建 Android APK（preview 配置）
npx eas build -p android --profile preview

# 构建 iOS 预览包（需 Apple 开发者账号）
npx eas build -p ios --profile preview
```
构建完成后下载安装到设备即可离线测试。

### 步骤五：验证核心功能
1. 在应用内输入一个含图片/视频的网页地址（如 B 站视频页、图文帖等）。
2. 等待页面加载与自动采集，确认结果列表出现图片与视频卡片。
3. 点击某条视频，确认能正常试播（B 站应带声音）。
4. 勾选若干资源，点击下载，确认能保存到相册 / 文件系统 / 分享面板。

## 已知限制
- 通过 **MSE**（MediaSource，播放 `blob:` 源）或 **WebRTC**（`srcObject` 直播流）的站点拿不到可下载直链，仅能诊断并提示。
- HLS / DASH 分片流暂不支持逐分片下载合并，仅支持音画分离的 fMP4 合并（DASH）。
- 部分站点的强登录态 / 复杂风控（如抖音异常重定向）可能无法稳定采集。

## 许可证
见 `LICENSE`。
