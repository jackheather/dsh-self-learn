#!/usr/bin/env node
/**
 * 自检：node / ffmpeg / python+faster-whisper / 数据目录 / 房间配置。
 * 用法：node scripts/doctor.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveConfig, ensureLayout, loadLiveState, loadRegistry } from "../src/store.js";

const dataArg = (() => {
  const i = process.argv.indexOf("--data");
  return i >= 0 ? process.argv[i + 1] || "" : "";
})();
const cfg = ensureLayout(resolveConfig(dataArg ? { dataDir: dataArg } : {}));
const rows = [];
const ok = (name, detail) => rows.push(`✓ ${name}${detail ? " — " + detail : ""}`);
const bad = (name, detail) => rows.push(`✗ ${name}${detail ? " — " + detail : ""}`);

ok("node", process.version);

const ff = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ff.status === 0) ok("ffmpeg", (ff.stdout || "").split("\n")[0]);
else bad("ffmpeg", "没找到 ffmpeg（把它放进 PATH）");

const conf = (() => {
  try {
    return JSON.parse(fs.readFileSync(cfg.configFile, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
})();
const py = conf.python || "python";
const imp = spawnSync(py, ["-c", "import faster_whisper,sys;print(faster_whisper.__version__)"], { encoding: "utf8" });
if (imp.status === 0) ok("faster-whisper", `${py} → ${(imp.stdout || "").trim()}`);
else bad("faster-whisper", `用 ${py} 导入失败；先装 venv 并把 config.json 的 python 指过去`);

try {
  fs.writeFileSync(path.join(cfg.dataDir, ".doctor"), "ok");
  fs.rmSync(path.join(cfg.dataDir, ".doctor"));
  ok("数据目录", cfg.dataDir);
} catch (e) {
  bad("数据目录", String(e.message));
}

const rooms = (conf.rooms || []).map((r) => (typeof r === "string" ? { id: r } : r)).filter((r) => r?.id);
if (rooms.length) ok("直播房间", rooms.map((r) => `${r.name || ""}${r.id}`).join(", "));
else bad("直播房间", "config.json 的 rooms 为空，learn_live 不会录");

const reg = loadRegistry(cfg);
const live = loadLiveState(cfg);
ok("学习库", `${Object.keys(reg).length} 个来源`);
ok("直播守护", live.pid ? `pid ${live.pid}` : "未运行");

const modelDir = path.join(cfg.modelsDir, `models--Systran--faster-whisper-${conf.model || "small"}`);
ok("模型缓存", fs.existsSync(modelDir) ? conf.model || "small" : `未下载（首次转写会自动下到 ${cfg.modelsDir}）`);

console.log(rows.join("\n"));
console.log("\n提示：ffmpeg 与 faster-whisper 都 ✓ 之后，learn_add BV1xxxxxxx 即可开始。");
console.log(rows.some((r) => r.startsWith("✗")) ? "结果：有失败项" : "结果：全部通过");
