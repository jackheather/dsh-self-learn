# dsh-self-learn · AI 自主学习插件

把 **B 站视频/直播、网页、本地文件** 变成每日学习源：采集和转写全在本地跑，摘要用启发式规则，模型只在最后读约 1.5KB 就能写出结构化笔记。

> 设计目标：**让"持续学习"这件事的 token 成本低到可以天天做。**

## 为什么省 token

| 环节 | 常规做法 | 本插件 |
| --- | --- | --- |
| 采集视频/直播 | 调模型总结整段 | ffmpeg + faster-whisper 本地跑，**0 token** |
| 看视频画面 | 让模型看每帧图 | 本地抽帧 + Windows OCR，**0 token** |\n| 读原始转写 | 30 分钟直播约 8K token | 启发式摘要 **约 600 token**，带时间戳可回查 |
| 写笔记 | 长文输出 | 五段骨架，工具落盘，模型只传要点 |
| 索引 | 每次全量读目录 | 只读 `index.md` 一行表 |

一个 30 分钟直播：约 **600–900 token** 完成"读 + 记 + 归档"，而不是 8K–15K。

## 能力

- **B 站视频**：给 BV 号/链接，自动取音频流（dash，免登录）→ 本地转写 → 摘要。
- **B 站直播**：常驻守护，开播即录（30 分钟一段），录完自动转写，token 0；重开播自动续录。
- **网页**：抓 HTML 正文（去脚本/样式/标签），摘要。
- **本地文件/目录**：txt / md / html / json / csv / docx / pdf（pdf 需 `pypdf`）。
- **画面（0 token）**：视频每 90 秒抽一帧 + Windows 自带 OCR，读得到字幕/UI/封面文字；直播录制期间同样每 90 秒快照，learn_frames 看清单，需要时再读图。\n- **笔记**：五段式（一句话 / 机制清单 / 可落地 / 原话钩子 / 存疑）+ 索引一行 + 可选信条一条。

## 安装

```bash
dsh plugin --profile desktop add dsh-self-learn
```

依赖（本机需有）：

```bash
# 1) ffmpeg 在 PATH 里
ffmpeg -version

# 2) 一个装好 faster-whisper 的 python（建议独立 venv）
python -m venv .venv
.venv\Scripts\pip install --no-cache-dir faster-whisper "av<14" -i https://mirrors.aliyun.com/pypi/simple/
```

然后在 `~/.dsh/self-learn/config.json` 里把 `python` 指到 `.venv\Scripts\python.exe`。

自检：

```bash
node scripts/doctor.mjs
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `learn_status` | 学习库状态 + 下一步建议（≤10 行） |
| `learn_add` | 加来源：BV号 / 网页 / 本地路径，后台采集 |
| `learn_digest` | 取 1.5KB 启发式摘要（唯一值得读进上下文的文本） |
| `learn_note` | 写五段式笔记 + 索引 + 可选信条 |
| `learn_live` | 直播守护 start / stop / status |

## 数据目录

```
~/.dsh/self-learn/
├── config.json          # rooms / python / model / creedFile
├── sources.json         # 来源登记表（状态机）
├── transcripts/         # 原始转写（不进上下文）
├── notes/               # 五段式笔记 + index.md
├── live/                # 直播分段音频（转写后删除）
├── models/              # whisper 模型缓存
└── live.log / acquire.log
```

## 已知限制

- 付费/充电视频可能需要 cookie（`config.json` 的 `cookie`）。
- 纯 JS 渲染的网页抓不到正文，会明确报错。
- docx 解压依赖 Windows PowerShell 的 `Expand-Archive`；pdf 需要 `pypdf`。
- 直播分段固定 30 分钟，主播中途下播会留下最后一段短录音，照样转写。

## 上架状态

代码、打包、安装、加载都已验证通过（证据见 [docs/验证记录.md](docs/验证记录.md)），包已就绪：`dsh-self-learn-0.1.0.tgz`（19 KB / 13 文件）。

剩下三步需要账号，步骤写在 [docs/上架指南.md](docs/上架指南.md)：

1. 建 GitHub 仓库 + 加 `dsh-plugin` topic + 补 `repository` 字段
2. `npm login && npm publish`
3. 往 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR：加一个 `data/plugins/<owner>__dsh-self-learn.yml`（模板在 [market/owner__dsh-self-learn.yml](market/owner__dsh-self-learn.yml)）

本地先用：

```bash
dsh plugin --profile web add "D:\工作\dsh-workspace\plugins\dsh-self-learn"
```

## License

MIT
