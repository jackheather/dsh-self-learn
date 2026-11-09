/**
 * dsh-self-learn — AI 自主学习插件
 *
 * 把「B 站视频/直播、网页、本地文件」变成每日学习源：
 *   采集（本地 ffmpeg + whisper，零模型调用）→ 启发式摘要（零 token）
 *   → 模型只读 1.5KB 摘要 → 写五段式笔记 + 索引 → 长期信条。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";

import {
  ensureLayout,
  loadLiveState,
  loadRegistry,
  resolveConfig,
  saveRegistry,
  sourceId,
  writeNote,
} from "./store.js";
import { digest } from "./digest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..", "scripts");

export const name = "self-learn";
export const inject = ["tools"];

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render(_args, value) {
    return [{ type: "text", text: String(value ?? "") }];
  },
};

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const N = (description, extra = {}) => ({ type: "number", description, ...extra });
const ARR = (description) => ({ type: "array", items: { type: "string" }, description });

function log(...args) {
  try {
    console.log("[self-learn]", ...args);
  } catch {
    /* ignore */
  }
}

function findEntry(registry, input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (registry[s]) return registry[s];
  const id = sourceId(s);
  if (registry[id]) return registry[id];
  const byRef = Object.values(registry).find((e) => e.ref === s || e.ref?.toLowerCase() === s.toLowerCase());
  if (byRef) return byRef;
  const byBv = Object.values(registry).find((e) => e.extra?.bv && s.toUpperCase().includes(e.extra.bv.toUpperCase()));
  return byBv || null;
}

function statusLine(entry) {
  const label = { queued: "采集中", ready: "已转写", digested: "已摘要", noted: "已成笔记", error: "失败" }[entry.status] || entry.status;
  return `${entry.id} ｜ ${label} ｜ ${entry.title || entry.ref}${entry.chars ? ` ｜ ${entry.chars} 字` : ""}`;
}

export function apply(ctx, rawConfig = {}) {
  const cfg = ensureLayout(resolveConfig(rawConfig));
  log("data:", cfg.dataDir);

  const tool = (def) => defineTool({ ...def, output: TEXT_OUTPUT });

  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const disposers = [];

      // ------------------------------------------------------------ learn_status
      disposers.push(
        sctx.tools.register(
          tool({
            name: "learn_status",
            description:
              "AI 自主学习：看当前学习库状态（已采集/待读/已成笔记、直播是否在录、下一步建议）。输出控制在 10 行内，随时可调，token 很便宜。",
            parameters: {},
            async execute() {
              const reg = loadRegistry(cfg);
              const list = Object.values(reg);
              const by = (st) => list.filter((e) => e.status === st);
              const live = loadLiveState(cfg);
              const liveRooms = Object.entries(live.rooms || {})
                .map(([id, r]) => `${r.name || id}${r.live ? "·在播" : "·离线"}`)
                .join(" / ");
              const pending = list.filter((e) => e.status === "ready" || e.status === "digested").slice(0, 5);
              const lines = [
                `学习库：${list.length} 个来源（B站 ${list.filter((e) => e.type === "bili").length}，网页 ${list.filter((e) => e.type === "web").length}，文件 ${list.filter((e) => e.type === "file" || e.type === "dir").length}）`,
                `待处理：采集 ${by("queued").length} ｜ 待读 ${by("ready").length} ｜ 待写笔记 ${by("digested").length} ｜ 已成笔记 ${by("noted").length} ｜ 失败 ${by("error").length}`,
                `直播：${liveRooms || "未配置房间"}${live.pid ? `（守护 pid ${live.pid}）` : ""}`,
              ];
              if (by("error").length) lines.push(`失败示例：${by("error").slice(0, 2).map((e) => `${e.id} ${String(e.error || "").slice(0, 60)}`).join("；")}`);
              if (pending.length) {
                lines.push("下一步（挑一个）：");
                for (const e of pending) lines.push(`  - learn_digest ${e.id}`);
              } else {
                lines.push("下一步：learn_add <BV号 | 网页URL | 本地文件/目录>");
              }
              return lines.join("\n");
            },
          }),
        ),
      );

      // -------------------------------------------------------------- learn_add
      disposers.push(
        sctx.tools.register(
          tool({
            name: "learn_add",
            description:
              "AI 自主学习：加一个学习源并后台采集。支持 B 站视频（BV 号/链接）、网页 URL、本地文件或目录（txt/md/html/docx/pdf）。采集与转写在本地跑，不调用模型；完成后用 learn_digest 取 1.5KB 摘要。",
            parameters: {
              source: S("BV号、视频链接、http(s) 网页地址，或本地文件/目录绝对路径"),
              title: S("可选：给这个来源起个短标题"),
            },
            async execute(args) {
              const src = String(args.source || "").trim();
              if (!src) return "缺少 source。示例：learn_add BV1xxxxxxx 或 learn_add https://example.com/post";
              const id = sourceId(src);
              const reg = loadRegistry(cfg);
              if (reg[id]) {
                const e = reg[id];
                if (e.status === "noted") return `已学过：${statusLine(e)} ｜ 笔记 ${e.noteFile || ""}`;
                if (e.status !== "error") return `已在队列：${statusLine(e)}`;
              }
              reg[id] = { id, type: id.startsWith("bili:") ? "bili" : id.startsWith("web:") ? "web" : "file", ref: src, title: args.title || src, status: "queued", at: new Date().toISOString() };
              saveRegistry(cfg, reg);
              const child = spawn(process.execPath, [path.join(SCRIPTS, "acquire-run.mjs"), "--data", cfg.dataDir, "--source", src, "--title", String(args.title || "")], {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
              });
              child.unref();
              return `已入队：${id}\n采集在后台跑（视频要先下载音频再本地转写，几分钟到几十分钟）。完成后 learn_status 会出现「待读」，再用 learn_digest ${id}。`;
            },
          }),
        ),
      );

      // ----------------------------------------------------------- learn_digest
      disposers.push(
        sctx.tools.register(
          tool({
            name: "learn_digest",
            description:
              "AI 自主学习：取某个来源的「启发式摘要」——本地从转写/正文里挑出高信息量句子，带时间戳，约 1.5KB。这是全流程唯一值得读进上下文的文本；读完直接写 learn_note，不要回头读原文。",
            parameters: {
              source: S("来源 id（如 bili:BV1xxxx）、BV号、URL 或路径"),
              maxChars: N("摘要上限字符，默认 1400"),
              maxLines: N("摘要最多行数，默认 26"),
            },
            async execute(args) {
              const reg = loadRegistry(cfg);
              const entry = findEntry(reg, args.source);
              if (!entry) return `没找到来源：${args.source}。先 learn_add，或 learn_status 看已有什么。`;
              if (entry.status === "queued") return `还在采集：${entry.id}。稍等，用 learn_status 看进度。`;
              if (entry.status === "error") return `采集失败：${entry.id}｜${entry.error || ""}`;
              if (!entry.transcriptPath || !fs.existsSync(entry.transcriptPath)) return `转写文件不见了：${entry.id}。重新 learn_add 可重采。`;
              const raw = fs.readFileSync(entry.transcriptPath, "utf8");
              const d = digest(raw, { maxChars: Number(args.maxChars) || 1400, maxLines: Number(args.maxLines) || 26 });
              const digestPath = entry.transcriptPath.replace(/\.txt$/, ".digest.txt");
              fs.writeFileSync(digestPath, d.text, "utf8");
              entry.status = entry.status === "noted" ? "noted" : "digested";
              entry.digestPath = digestPath;
              entry.digestStats = d.stats;
              saveRegistry(cfg, reg);
              return [
                `# ${entry.title || entry.id}`,
                `来源：${entry.ref}`,
                `摘要：${d.stats.picked}/${d.stats.units} 句 · ${d.stats.chars} 字（原文 ${raw.length} 字，省约 ${Math.max(0, Math.round((1 - d.stats.chars / Math.max(1, raw.length)) * 100))}%）`,
                "",
                d.text,
                "",
                `→ 写笔记：learn_note source=${entry.id} title=… oneLine=… mechanisms=[…] actions=[…] quotes=[…] doubts=[…]`,
              ].join("\n");
            },
          }),
        ),
      );

      // ------------------------------------------------------------- learn_note
      disposers.push(
        sctx.tools.register(
          tool({
            name: "learn_note",
            description:
              "AI 自主学习：把摘要写成一篇五段式笔记（一句话/机制清单/可落地/原话钩子/存疑），写进 notes 目录并在索引里加一行。只回文件路径，不回正文。可选 creed 追加一条长期铁律。",
            parameters: {
              source: S("来源 id / BV号 / URL / 路径"),
              title: S("笔记标题，默认用来源标题"),
              oneLine: S("一句话总结（必填，≤80 字）"),
              mechanisms: ARR("机制清单，每条一句"),
              actions: ARR("可落地动作，每条一个 checkbox"),
              quotes: ARR("原话钩子，1–3 条"),
              doubts: ARR("存疑/待验证"),
              creed: S("可选：要追加到信条文件的一条铁律"),
            },
            async execute(args) {
              const reg = loadRegistry(cfg);
              const entry = findEntry(reg, args.source);
              if (!entry) return `没找到来源：${args.source}`;
              if (!args.oneLine) return "至少给一句 oneLine（一句话总结），否则笔记没有骨架。";
              const r = writeNote(cfg, {
                id: entry.id,
                type: entry.type,
                sourceTitle: entry.title || entry.ref,
                title: args.title || entry.title || entry.id,
                oneLine: args.oneLine,
                mechanisms: args.mechanisms || [],
                actions: args.actions || [],
                quotes: args.quotes || [],
                doubts: args.doubts || [],
                creed: args.creed || "",
              });
              entry.status = "noted";
              entry.noteFile = r.file;
              entry.notedAt = new Date().toISOString();
              saveRegistry(cfg, reg);
              return `笔记已写：${r.file}\n索引：${cfg.indexFile}（+1 行）${args.creed && cfg.creedFile ? `\n信条：已追加一条` : ""}`;
            },
          }),
        ),
      );

      // ------------------------------------------------------------- learn_live
      disposers.push(
        sctx.tools.register(
          tool({
            name: "learn_live",
            description:
              "AI 自主学习：B 站直播跟播。start 起常驻守护（每 30 分钟一段，录完自动本地转写，全程不调模型=0 token）；stop 停止；status 看待播房间与队列。房间在数据目录 config.json 的 rooms 里配。",
            parameters: {
              action: S("start | stop | status"),
              rooms: S("可选：逗号分隔的房间号，如 4199783,26897779；start 时更新"),
            },
            async execute(args) {
              const action = String(args.action || "status").toLowerCase();
              const live = loadLiveState(cfg);
              if (action === "start") {
                if (live.pid) return `守护已在跑（pid ${live.pid}）。要重启先 stop。`;
                if (args.rooms) {
                  const rooms = String(args.rooms)
                    .split(/[,，\s]+/)
                    .filter(Boolean)
                    .map((id) => ({ id: String(id), name: "" }));
                  try {
                    const conf = JSON.parse(fs.readFileSync(cfg.configFile, "utf8"));
                    conf.rooms = rooms;
                    fs.writeFileSync(cfg.configFile, JSON.stringify(conf, null, 2), "utf8");
                  } catch {
                    /* ignore */
                  }
                }
                const child = spawn(process.execPath, [path.join(SCRIPTS, "daemon.mjs"), "--data", cfg.dataDir], {
                  detached: true,
                  stdio: "ignore",
                  windowsHide: true,
                });
                child.unref();
                return `已启动直播守护（pid ${child.pid}）。轮询/录音/转写全在本地，token 0。用 learn_live status 看状态。`;
              }
              if (action === "stop") {
                if (!live.pid) return "守护没在跑。";
                try {
                  process.kill(live.pid);
                } catch (e) {
                  return `停止失败（pid ${live.pid} 可能已退出）：${e.message}`;
                }
                return `已发送停止：pid ${live.pid}`;
              }
              const rooms = Object.entries(live.rooms || {})
                .map(([id, r]) => `- ${r.name || id}：${r.live ? "在播" : "离线"}${r.current ? ` ｜ ${r.current}` : ""}`)
                .join("\n");
              const q = (live.queue || []).filter((x) => x.status !== "done").length;
              return `守护：${live.pid ? `运行中 pid ${live.pid}` : "未运行"}\n房间：\n${rooms || "（未配置；learn_live start rooms=4199783）"}\n转写队列：${q} 条未完成`;
            },
          }),
        ),
      );

      return () => {
        for (const d of disposers) {
          try {
            d?.();
          } catch {
            /* ignore */
          }
        }
      };
    });
  });
}
