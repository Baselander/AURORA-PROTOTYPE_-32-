# info\materials —— 「课件库」的数据半边（抽取 → 切块 → 建索引 → 检索）

> 一句话：**让她回答学业问题之前，先从主人自己的课件/讲义里检索出相关片段**。
> 本目录只交付到 CLI 为止；**接进她的话（改 `info\brain.mjs`）由主人自己接**，这里不碰。

---

## 一、三条命令（形状是定好的，接的时候照这个用）

```bat
:: 1) 建/更新索引（递归子目录；支持 .pdf .docx .pptx .txt .md）
node info\materials\index-files.mjs --dir "AURORA_DATA" [--rebuild] [--json]
::    → { ok, added, skipped, totalChunks, warnings: [{file, reason}] }

:: 2) 检索（默认 bm25，纯本地、零依赖、不联网）
node info\materials\query.mjs --q "水的氢键为什么强" [--k 5] [--json]
::    → { ok, hits: [{ source, page, score, text }] }

:: 3) 看现状（只读）
node info\materials\stats.mjs [--json]
::    → 已索引多少文件 / 多少块 / 最后更新时间 / 引擎
```

可选参数：`--root "<数据目录>"` 覆盖数据目录；`--size 450 --overlap 50` 改切块口径（默认就是这两个值）。

**数据落在哪**：`<数据目录>\_study-core\课件库\`（`manifest.json` + `chunks.jsonl`）。
数据目录解析与全项目一致（`info\paths.ps1`、`info\brain.mjs`）：

1. `$env:DSH_DATA` 2. 开发机旧路径 `AURORA_DATA` 3. `<项目根>\端口样例`

**只碰这一个新目录**：本卡不写 `_study-core` 里任何别的文件（tasks.json / 收件箱 / 错题本 / 她的打扮.json …都不动）。

---

## 二、来源与署名（必须保留）

- **来源**：主人 2026 年暑假项目 **ClassCapainAI**（同学友谊项目，仓库位于 `…\AIproject\classcaptain\ClassCapainAI`）。
  本目录**借鉴了它的设计思路与接口形态**，代码是**重新写的**（零依赖、纯 Node）。
- **借鉴的文件**（只读参考，**一个字都没改**；也没有复制 `classcaptain\key\` 里任何 key）：
  | 参考文件 | 借鉴了什么 |
  |---|---|
  | `db_operations.py` | 文档 → 按页切块（chunk_size=500, overlap=50）→ 带 `{source, page, chunk_index}` 入库 |
  | `llm_handler.py` | 检索结果拼成「【来源：…】\n正文」塞进提示词的形状（本卡只做到 hits，接入在 `brain.mjs`） |
  | `src\document_parser\pdf_parser.py` | PDF 用 PyMuPDF（fitz）按页取文字；本目录写成 `_pdf_text.py` 子进程（输出 JSON） |
  | `src\document_parser\ppt_parser.py` | pptx 一页一张、只取形状文字（`<a:t>`） |
  | `src\document_parser\word_parser.py` | docx 取段落文字（本目录还取了表格里段落，见下） |
  | `src\utils\text_splitter.py` | 句子级累积切块 + 50 字重叠的思路 |
  | `monitor.py` | 监听新文件 → 处理（本卡没做 watcher；`index-files.mjs` 可重复跑，靠指纹跳过没变的文件） |
  | `config.py` | persona + 路径约定（persona 在 `info\brain.mjs` 那边，本卡不碰） |
- **许可/署名**：参考实现为私人友谊项目，作者为主人与同学；本目录沿用其思路并在此署名，未引入其第三方依赖
  （chromadb / sentence-transformers / python-docx / python-pptx / watchdog / faster-whisper 一个都没装）。
  若原作者要求更具体的许可条款，以他们的说法为准；本目录是内部工具，不对外分发。

**我们和参考实现的差别**（都是有意为之，不是漏做）：

| 维度 | 参考实现 | 这里 |
|---|---|---|
| docx/pptx 抽取 | python-docx / python-pptx | **零依赖**：ZIP（node:zlib inflateRawSync）+ 正则取 `<w:t>` / `<a:t>` |
| 检索 | Chroma 向量（sentence-transformers） | **BM25**（中文 2-gram），完全本地、可解释；`--engine chroma` 留了口子但**探测不到就明确报错，不静默降级** |
| 切块 | 先整篇切块再按页 | **先按页/张切，页内再按句累积**（保住 page/slide 归属） |
| 增量 | 每次全量 | **size + mtime + sha1 前 16 位**指纹，没变就跳过；目录里删掉的文件会从索引里摘掉 |
| 失败处理 | `print(...) + raise` | **warnings[] 带人话原因**（区分“不是 ZIP/加密”和“ZIP 损坏”），单文件失败不影响其它文件 |
| docx 定位 | 一页（page=1） | 同（docx 没有可靠页码）；表格单元格的段落也会被取到，但切块后是独立行（不以“ | ”拼一行） |
| 输出 | 控制台打印正文 | **不打印正文**：只打文件名 + 分数 + 前 20 字 |

---

## 三、PDF 怎么办（现在默认跳过）

本机探测：`python -c "import fitz"` **失败**（没装 PyMuPDF），所以：

- `.pdf` 一律进 `warnings`，原因写得很明确（"PDF 抽取未启用：没探测到 PyMuPDF…"），**不崩、不产出空块**；
- 想启用（不改系统 python）：
  ```bat
  python -m venv info\materials\.venv
  info\materials\.venv\Scripts\python -m pip install PyMuPDF
  :: 之后 index-files.mjs 会自动优先用 info\materials\.venv\Scripts\python.exe
  ```
  探测顺序：`info\materials\.venv` → `$env:DSH_PYTHON` → `python`（都不改系统包）。

## 四、坏情况怎么表现（都不会崩）

| 情况 | 结果 |
|---|---|
| 空目录 | `added 0 / skipped 0 / totalChunks 0`，无 warnings |
| 不支持的扩展名（.exe/.xlsx/.png…） | 每个进 warnings「不支持的扩展名（跳过）」（列表最多 50 条，其余汇总成一条） |
| 故意损坏的 .docx/.pptx（不是 ZIP） | warnings：「不是有效的 ZIP/Office 文件：可能被密码加密…或文件损坏」 |
| 密码加密的 Office 文档（OLE，不是 ZIP） | 同上，原因里点名“加密” |
| 扫描图片版 PDF / 纯图 PPT | warnings：「抽取为空…」 |
| 索引文件里某行坏了 | 跳过该行继续；`stats --json` 的 `badLines` 报数量 |
| 单个 slide XML 损坏 | 跳过该张并记 warning，其余页照常索引 |

## 五、文件清单

| 文件 | 干什么 |
|---|---|
| `index-files.mjs` | CLI：扫目录 → 抽取 → 切块 → 写索引 |
| `query.mjs` | CLI：BM25（或可选 chroma）检索 |
| `stats.mjs` | CLI：看索引现状 |
| `paths.mjs` | 数据目录解析 + Python 探测（venv 优先） |
| `zip.mjs` | 只读 ZIP 解包（零依赖，node:zlib） |
| `xml.mjs` | 解实体 + 按标签取文本（零依赖） |
| `extract.mjs` | docx/pptx/txt/md/pdf 抽取 + 失败原因翻译 |
| `chunk.mjs` | 句子级切块（~450 字 / 50 字重叠） |
| `bm25.mjs` | 中文 2-gram 切词 + BM25 打分 |
| `store.mjs` | manifest/chunks 读写（先写 .tmp 再 rename） |
| `_pdf_text.py` | PDF 抽文字（PyMuPDF，可选；输出一行 JSON） |
| `_chroma_query.py` | chroma 查询（可选，未装 chromadb 时不会被走到） |

## 六、接入提示（给后续改 `brain.mjs` 的人）

- 检索结果里 `text` 是**块正文**、`source` 是**文件绝对路径**、`page` 是页码（pptx 是第几张）；
- 建议拼成：`【来源：<文件名> 第 N 页】\n<text>` 后用 `\n---\n` 连接（同参考实现的形状）；
- 想“只引用、不贴全文”就直接用 `hits[].text`；命令行的非 JSON 输出已经按“只前 20 字”处理过了；
- `--json` 的 stdout **只有一行 JSON**，可以直接 `child_process.execFileSync(process.execPath, [...])` 拿。
