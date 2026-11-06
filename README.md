# 拾流 · 网页影音下载器

为桌面版 Chrome 和 Edge 识别当前标签页中的视频、音频和播放清单。普通媒体文件交给浏览器下载。未加密的 HLS 点播可以选画质、选音轨，并逐片保存到本地，单个输出文件最大 **4 GiB**。

**[下载拾流 1.1.1 安装包](./Shiliu-1.1.1.zip?raw=true)**

## 安装

1. 将安装包解压到准备长期保留的文件夹。使用本仓库源码时，直接选择 `extension` 文件夹即可。
2. 在 Chrome 打开 `chrome://extensions/`，在 Edge 打开 `edge://extensions/`。
3. 开启「开发者模式」，点击「加载已解压的扩展程序」，选择直接包含 `manifest.json` 的文件夹。

升级时，将新版覆盖到原目录，在扩展管理页点击拾流卡片上的「重新加载」。两个浏览器需分别重新加载。

## 下载

在目标网页播放几秒，打开拾流，按类型筛选资源。

| 资源 | 操作 |
| --- | --- |
| MP4、WebM、MP3、M4A 等媒体文件 | 点击「下载」，在浏览器下载记录中查看进度。 |
| HLS 点播（M3U8） | 点击「打开」，选择画质或音轨，再点「选择位置并下载」。保持下载页打开到显示「已保存」。 |
| DASH（MPD） | 「保存清单」会得到描述轨道和分片地址的 MPD 文件。 |

HLS 每次导出一个轨道。如果网站把声音和画面分开，需要分别保存。支持常见的 MPEG-TS、带初始化片段的 fMP4、AAC 和 MP3。直播、加密清单和 DRM 内容超出本版支持范围。部分站点使用临时链接或要求专用请求头，下载失败时可刷新原网页，重新播放并扫描。

## 权限与数据

拾流在本机读取 HTTP 和 HTTPS 媒体请求的响应类型、文件名和长度，并在打开面板或重新扫描时检查网页中的播放器。跨域播放器和 CDN 也需要相应的网站访问权限。资源清单在浏览器会话中按标签页暂存，下载直接访问源站。扩展的运行代码和图标均随包提供。

## 测试

使用 Node.js 24 或更新版本，在仓库根目录运行 `node --test tests/capture.test.cjs tests/hls.test.mjs`。安装和使用扩展只需浏览器。

## 参考项目

- 媒体识别参考了猫抓结合响应类型、文件名和分段响应总长度的做法。所参考版本采用 GPLv3。[相关实现](https://github.com/xifangczy/cat-catch/blob/2f84456f86230a88bbc8c67ba9ea15fcd64635d6/js/background.js) · [上游许可证](https://github.com/xifangczy/cat-catch/blob/2f84456f86230a88bbc8c67ba9ea15fcd64635d6/LICENSE)
- HLS 的画质与独立音轨选择参考了 HLS Downloader 的功能设计。所参考版本采用 MIT 许可证。[功能说明](https://github.com/puemos/hls-downloader/blob/21ba8008a545843b9b34ff709614133873dc59a7/FUNCTIONALITIES.md) · [上游许可证](https://github.com/puemos/hls-downloader/blob/21ba8008a545843b9b34ff709614133873dc59a7/LICENSE)
