# 历史知识库 · 高中三年历史知识清单

一个**完全离线可用**的单页学习工具：左侧章节树、中间知识点列表、右侧详情。支持全文检索、笔记、自定义知识点、错题本（1/3/7/15/30 天排期）、三种备份与 PDF 原书跳页。

- 纯静态，无后端；除内置 pdf.js 外无任何联网依赖，断网可继续使用。
- 用户数据（笔记 / 自定义知识点 / 错题 / 配置 / 快照）只存浏览器 localStorage，与 `data/` 静态数据严格分离，重新部署不会覆盖。
- 当前内容：**66 课共 323 条**，章节树完整录入 2 册 / 6 部 / 21 单元 / 66 课。314 条带原文摘录，9 条因扫描页无对应正文标为“考点归纳”，界面会显示不同徽标。

## 本地启动

```bash
cd history
python3 -m http.server 8123
# 打开 http://127.0.0.1:8123/
```

> 不能直接双击 `index.html`（`file://` 下 fetch JSON 与 Service Worker 会被浏览器拦截）。

## 目录结构

```
history/
├─ index.html                 单页入口
├─ sw.js                      离线缓存（改版本号可强制换新）
├─ assets/
│  ├─ css/app.css             视觉规范 + 响应式
│  ├─ js/app.js               渲染、检索、详情、错题、PDF、快捷键
│  ├─ js/store.js             用户数据、快照、导入导出、CSV/Markdown
│  ├─ js/search-worker.js     倒排索引 + 同义词 + 拼音首字母 + 模糊匹配
│  └─ vendor/pdfjs/           本地 pdf.js 4.10.38（legacy）
├─ data/
│  ├─ knowledge.json          知识点（静态，只读）
│  ├─ books.json              章节树（静态，只读）
│  ├─ aliases.json            同义词/别名表
│  └─ pinyin.json             汉字→拼音首字母
└─ README.md
```

## 功能与快捷键

| 操作 | 方式 |
| --- | --- |
| 全局搜索 | `/` 或 `Cmd/Ctrl + K` |
| 关闭弹层 / 清空搜索 | `Esc` |
| 上下切换知识点 | `j` / `k` |
| 快捷键面板 | `?` |

- **检索**：一个框同时搜知识点、笔记、错题；关键词高亮；空结果给最相近 5 条；支持按书 / 章 / type / 难度 / 掌握状态筛选。
- **知识点**：树形展开；可标「已掌握 / 待复习」；详情含要点、原文摘录（有则显示）、关键词、可能考法与页码。
- **自定义知识点**：表单创建，来源固定显示「我创建」，可编辑、删除。
- **错题本**：题干 / 我的答案 / 正确答案 / 错因（概念不清·审题失误·计算错·记忆偏差）/ 关联知识点 / 错误次数 / 上次与下次复习；按 1、3、7、15、30 天排期，到期在首页提示。
- **PDF 跳页**：首次选择本地 PDF 后存入 IndexedDB（`hs-files/files/LS-pdf`），之后点「打开原书」直接跳到 `PDF 页 = 书页 + 3`。

## 数据备份

右上角「备份」：

1. **导出完整 JSON**：笔记 + 自定义知识点 + 错题 + 配置，文件名带日期时间。
2. **导入 JSON**：先校验 schema，冲突时可选「覆盖」或「合并」；合并按 id 去重、保留较新修改。
3. **自动快照**：导入、批量标记、批量删除前自动写入，保留最近 5 份，可一键回滚。
4. **额外导出**：错题 CSV（Excel 可直接打开）、知识点 Markdown（Obsidian 可直接收）。
5. 首页显示「上次备份时间」，超过 7 天显示一行提醒。

localStorage 键：

- `hs.user.v1` 用户数据
- `hs.snapshots.v1` 快照（最多 5 份）

## 加新书 / 补全其余课时

当前只抽了第 1–3 课。补全流程（每一步都要人工核对原文，禁止让模型自由发挥）：

1. **OCR**：扫描页用 `_tools/ocr`（macOS Vision）逐页识别，输出 `_work/ocr_raw.json`；清洗成 `_work/page_text.json`（去页脚、按几何合并折行）。OCR 只作辅助，表格列错位、形近字必须回图核对。
2. **抽知识点**：按课逐页读图，产出 `data/knowledge.json`，字段固定：
   `id / book / unit / lesson / title / content / excerpt / source / page / pdfPage / keywords / type / difficulty / commonq`。
   硬规则：`title ≤ 20` 字、`content ≤ 120` 字、`excerpt ≤ 100` 字且**一字不改**、`keywords 3–6` 个、四要素（摘录+书名+章+节+页码）齐全；找不到页码写「未定位」，不许编。
3. **校验**：跑 `_work/build_knowledge.py`（长度、字段、类型硬校验），再把摘录与 `page_text.json` 做字符序列比对，未命中的逐条回图确认。
4. **章节树**：新课若改变结构，改 `data/books.json`（书→部→单元→课），并同步 `knowledge.json` 的 `unit/lesson`。
5. **索引**：重建 `data/aliases.json`（新术语别名）与 `data/pinyin.json`（新字注音），刷新页面即自动重建倒排索引。
6. **离线缓存**：改 `sw.js` 里的 `CACHE = 'hs-static-v2'`，让老用户换到新资源。

## 部署到 GitHub Pages

```bash
git clone https://github.com/sereniiiii/history.git
cd history
# 把本目录文件放进来（不要放 _work、PDF 原书）
git add -A
git commit -m "feat: 知识库学习工具"
git branch -M main
git push -u origin main
```

仓库 Settings → Pages → Source: Deploy from a branch → `main` → `/ (root)`，地址：

`https://sereniiiii.github.io/history/`

若 `github.com` 被解析到不可达 IP，可先试 `140.82.114.4` / `140.82.121.4`；仍不通再走本地隧道：

```bash
python3 ~/.config/study-hub/gh-tunnel.py 140.82.114.4 18443
git -c http.proxy=http://127.0.0.1:18443 push -u origin main
```

不要用 REST API 上传（`PUT /contents` 会 403），一律走 git 协议。

### 版权

`data/knowledge.json` 含每节 ≤100 字原文摘录，属合理引用范围；**PDF 原书与整页 OCR 文本不要提交**。若希望仓库私有，注意 GitHub Pages 私有仓库需付费方案；免费方案下建议公开仓库但只保留摘录与自建内容。

## 实测性能（本机 headless Chrome，1000 条压测）

| 指标 | 结果 |
| --- | --- |
| 初始化 | 5.2 ms |
| 首次内容渲染 | 16 ms（本地缓存命中） |
| 64 条搜索 | 平均 0.1 ms / 最大 0.2 ms |
| 1000 条搜索 | 平均 0.2 ms / 最大 0.3 ms |
| 1000 条列表渲染 | 仅 13 张卡片（视口 ±10） |
| 滚动帧率 | 60.1 fps，最大帧间隔 23.6 ms |

自测入口：`http://127.0.0.1:8123/index.html?selftest=1`，结果在 `window.__SELFTEST__`。

## 已知限制

- 内容仅覆盖第 1–3 课（64 条），其余 63 课在树中显示 0 条并标「试点」。
- PDF 需用户首次手动选择文件（浏览器安全限制，不能自动读取本地路径）；文件存 IndexedDB，换浏览器需重新选择。
- OCR 对表格与形近字有误差，所有摘录均已回图人工核对；后续扩量必须沿用同一流程。
