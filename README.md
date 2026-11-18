# Bili Comments Sidebar / B站评论侧栏 (fork v3.1)

一个 Edge/Chrome 扩展（Manifest V3），为 Bilibili 视频页面提供左视频、右评论栏的双栏浏览体验，评论时间戳可点击跳转。

基于商店版 [Bili Comments Sidebar](https://chromewebstore.google.com/detail/bili-comments-sidebar/lepfkokibljdknhnmhokknpfkibckblm) 1.3.0 的本地 fork，重构并扩展。

## 功能特性

- **双栏布局** — 视频在左，评论/简介栏在右（默认进入 简介 页）
- **评论·简介切换** — 标签行一键切换：评论 = 本扩展的评论栏；简介 = B站原生右栏（相关视频/UP主卡片）
- **时间戳跳转** — 评论中的 03:25 等时间自动变为可点击，主播放器 seek 并播放
- **排序** — 评论「热门/最新」；楼中楼「回复·热度/回复·时间」（客户端重排）
- **搜索/高亮** — 顶部搜索框过滤评论并高亮命中
- **无限滚动** — 评论列表内部滚动到底自动加载更多
- **回复展开** — 展开完整回复楼层（Reddit 风格缩进线）
- **UP主标记 / 等级标签 / B站表情 / 图片评论**
- **SPA 适配** — 站内切换视频自动刷新评论并回到默认标签
- **默认标签设置** — 标签行右侧 💬 按钮切换「新视频默认打开评论」；常亮浅色主题融入 B站白底（v3.1 起固定，无主题切换）

## 安装 (Edge)

1. `edge://extensions` 打开「开发人员模式」。
2. 若装过商店版 Bili Comments Sidebar，先停用它（避免双份注入）。
3. 「加载解压缩的扩展」选择本目录。
4. 每次修改代码后在 edge://extensions 点「重新加载」，并 **F5 刷新已打开的视频页**（扩展重载不会重新注入旧标签页）。底部 `v3.0.0` 徽标可确认新脚本已生效。

## 使用说明

| 操作 | 方式 |
|------|------|
| 切换 评论/简介 | 右栏顶部标签行「简介 / 评论 N」，两种模式下标签行常驻 |
| 切换排序 | 顶部「热门」/「最新」 |
| 刷新评论 | 工具栏刷新按钮 |
| 加载更多 | 评论列表内滚动到底自动加载 |
| 时间戳跳转 | 点击评论里的 mm:ss |
| 回到顶部 | 列表底部「⬆ 回到顶部」 |
| 新视频默认标签 | 标签行右侧 💬 按钮：点亮 = 打开视频/切视频直接进评论页，熄灭 = 简介页 |

## 架构 (v3.1)

### 硬约束（血泪结论，改动前必读）

bisect + E1–E4 闲置页对照实验 + 全模式复现证明：**任何外来节点插入 B站 `#app` 子树内部（`.right-container` 或其父级 `.video-container-v1`），只要落在 B站挂载/重建窗口内，就会让 `bili-header` 的片段锚点重挂载崩溃**（`nextSibling of null` → `#biliMainHeader` 变空壳 → 顶部导航消失）；插入 `.right-container` 内部还会额外永久破坏 `video-awesome-img` 懒加载注册表（原生右栏灰图）。因此：

### 布局：body 固定面板 + 槽位跟随

- `#bili-comments-sidebar` 永远挂在 `<body>`，`position:fixed`，**绝不进入 `#app` 子树**；
- `positionSidebar()` 只读原生 `.right-container` 的矩形、写自己的内联样式：top 每帧跟随槽位（rAF 节流 scroll 监听）＝ 文档流观感；left/width 由 1s 漂移巡检 + resize 跟踪；剧场模式（槽位过小）自动隐藏；
- **对 B站 DOM 的改动量为零**（不插节点、不改类名，只在 `<html>` 上开关自己的类，见下）。

### 双模式：纯 CSS 切换

| 模式 | <html> 类 | 效果 |
|------|-----------|------|
| 评论（默认隐藏时） | `bcs-layout` | 原生右栏 `visibility:hidden`（保留 411px 槽位，页面几何不变），面板盖在空槽上 |
| 简介 | `+ bcs-intro-page` | 评论机器隐藏，标签行仍钉在列顶；原生内容 CSS `margin-top:52px` 下移让位 |

### 视频信息获取

优先从页面内联 `<script>`（`__INITIAL_STATE__` SSR 数据）正则提取 aid/UP主/统计（内容脚本隔离世界读不到 `window.__INITIAL_STATE__`，但 `<script>` 标签文本是共享 DOM）；view API 仅作 SPA 导航兜底 —— 已删除视频（API `-404`）也能出评论列表。

### 事件穿透

部分页面状态会给祖先设 `pointer-events:none`；面板 shell 上显式 `pointer-events:auto` 保证子树可命中。

## 代码结构

```
manifest.json   MV3；content_scripts: [lib.js, content.js]（同一隔离世界按序执行）
lib.js          BCSLib 纯函数库（零 DOM/chrome 依赖）：BV 解析、__INITIAL_STATE__
                提取、评论树构建、时间格式化、HTML 转义/表情/时间戳链接化/高亮
content.js      DOM 胶水层：状态 S、评论 API、面板 UI/事件、槽位跟随、SPA 监听
sidebar.css     面板样式与双模式规则
tests/          node:test 单元测试（node --test tests/）
icons/          图标
```

## 开发与测试

```bash
npm test      # node --test tests/  （需要 Node 18+；PATH 上的 node 必须是真 Node 而非 Electron shim）
npm run check # node --check lib.js content.js
```

纯逻辑全部下沉 `lib.js` 并有 20 个单测覆盖（时间解析、万位格式化、相对时间、评论树嵌套/孤儿/排序、转义、时间戳链接化、高亮转义、SSR 提取、表情、图片）。DOM 胶水层无自动化测试，靠手动回归清单：顶部导航存活、双标签切换、楼中楼展开、时间戳 seek、滚轮不拖页、无限加载、SPA 切视频。

## 相对商店版 1.3.0 的改动

1. 时间戳可点击跳转（`window.player.seek(sec,true)` 优先，`<video>` 元素兜底）。
2. 双栏布局（上述 body 面板架构）：评论栏与 B站原生右栏互斥，默认简介页。
3. 常驻开启：移除悬浮球/关闭按钮/Alt+C/拖拽调宽；无限加载改列表内 IntersectionObserver。
4. 评论列表自带滚动容器（`overscroll-behavior:contain`），滚轮不再拖动整页。
5. v3.0 工程重构：纯函数库 + 单元测试、删除诊断脚手架（bcsMode/bcsBoot 门、事件救援层、启动窗口）、清理死代码与过期注释、manifest 3.0.0。
6. v3.1：删除明暗主题切换（固定浅色）；月亮按钮改为 💬，功能改为「新视频默认打开评论」开关（chrome.storage 记忆，硬加载与 SPA 切换都生效）。

## 技术说明

- Manifest V3，仅 `storage` 权限
- Bilibili 公开 API（`/x/v2/reply`、`/x/v2/reply/reply`），请求携带 Cookie（登录 B站 可获完整评论）
