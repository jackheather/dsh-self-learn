import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_CONFIG = {
  enabled: true,
  dataDir: "",
  /** 要跟的直播间：[{ id, name }] */
  rooms: [],
  /** ASR 用的 python（含 faster-whisper）；空 = python */
  python: "",
  model: "small",
  indexFile: "",
  creedFile: "",
  cookie: "",
  segmentSecs: 1800,
  maxBiliMinutes: 120,
  maxWebChars: 400000,
  maxFileBytes: 400000,
  maxDirFiles: 40,
};

export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.dataDir = cfg.dataDir ? path.resolve(cfg.dataDir) : path.join(os.homedir(), ".dsh", "self-learn");
  cfg.notesDir = path.join(cfg.dataDir, "notes");
  cfg.transcriptDir = path.join(cfg.dataDir, "transcripts");
  cfg.liveDir = path.join(cfg.dataDir, "live");
  cfg.modelsDir = path.join(cfg.dataDir, "models");
  cfg.tmpDir = path.join(cfg.dataDir, "tmp");
  cfg.stateFile = path.join(cfg.dataDir, "state.json");
  cfg.registryFile = path.join(cfg.dataDir, "sources.json");
  cfg.liveStateFile = path.join(cfg.dataDir, "live-state.json");
  cfg.configFile = path.join(cfg.dataDir, "config.json");
  cfg.indexFile = cfg.indexFile ? path.resolve(cfg.indexFile) : path.join(cfg.notesDir, "index.md");
  return cfg;
}

export function ensureLayout(cfg) {
  for (const dir of [cfg.dataDir, cfg.notesDir, cfg.transcriptDir, cfg.liveDir, cfg.modelsDir, cfg.tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(cfg.configFile)) {
    const seed = { ...DEFAULT_CONFIG };
    fs.writeFileSync(cfg.configFile, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }
  if (!fs.existsSync(cfg.registryFile)) fs.writeFileSync(cfg.registryFile, "{}\n", "utf8");
  if (!fs.existsSync(cfg.stateFile)) fs.writeFileSync(cfg.stateFile, JSON.stringify({ queue: [] }, null, 2), "utf8");
  return cfg;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export const loadRegistry = (cfg) => readJson(cfg.registryFile, {});
export const saveRegistry = (cfg, r) => writeJson(cfg.registryFile, r);
export const loadLiveState = (cfg) => readJson(cfg.liveStateFile, { pid: 0, rooms: {}, queue: [] });
export const saveLiveState = (cfg, s) => writeJson(cfg.liveStateFile, s);

export function parseBv(input) {
  const s = String(input ?? "").trim();
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  if (m) return m[0];
  const a = s.match(/^av(\d+)$/i);
  if (a) return "av" + a[1];
  return "";
}

export function isUrl(s) {
  return /^https?:\/\//i.test(String(s ?? "").trim());
}

export function hashId(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
}

export function sourceId(input) {
  const s = String(input ?? "").trim();
  const bv = parseBv(s);
  if (bv) return "bili:" + bv;
  if (isUrl(s)) return "web:" + hashId(s);
  return "file:" + hashId(path.resolve(s));
}

export function slugify(s) {
  const cleaned = String(s ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return cleaned || "note";
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ensureIndex(cfg) {
  if (!fs.existsSync(cfg.indexFile)) {
    fs.mkdirSync(path.dirname(cfg.indexFile), { recursive: true });
    fs.writeFileSync(
      cfg.indexFile,
      "# 学习笔记索引\n\n> 先查这张表，再决定读哪篇；不要全量读笔记目录。\n\n| 笔记 | 来源 | 一句话 |\n| --- | --- | --- |\n",
      "utf8",
    );
  }
  return cfg.indexFile;
}

export function writeNote(cfg, note) {
  const date = note.date || today();
  const title = String(note.title || note.sourceTitle || note.id || "学习笔记").trim();
  const file = path.join(cfg.notesDir, `${date}-${slugify(title)}.md`);
  const lines = [
    `# ${title}`,
    "",
    `> 来源：${note.sourceTitle || note.id || ""} ｜ 类型：${note.type || ""} ｜ 日期：${date}`,
    "",
    "## 一句话",
    "",
    note.oneLine || "",
    "",
    "## 机制清单",
    "",
    ...(note.mechanisms?.length ? note.mechanisms.map((x) => `- ${x}`) : ["- （待补）"]),
    "",
    "## 可落地",
    "",
    ...(note.actions?.length ? note.actions.map((x) => `- [ ] ${x}`) : ["- [ ] （待补）"]),
    "",
    "## 原话钩子",
    "",
    ...(note.quotes?.length ? note.quotes.map((x) => `> ${x}`) : ["> （无）"]),
    "",
    "## 存疑",
    "",
    ...(note.doubts?.length ? note.doubts.map((x) => `- ${x}`) : ["- 无"]),
    "",
  ];
  fs.mkdirSync(cfg.notesDir, { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  ensureIndex(cfg);
  const row = `| [${title}](${path.basename(file)}) | ${note.sourceTitle || note.id || ""} | ${(note.oneLine || "").slice(0, 80)} |`;
  fs.appendFileSync(cfg.indexFile, row + "\n", "utf8");
  if (note.creed && cfg.creedFile) {
    try {
      fs.appendFileSync(cfg.creedFile, `\n- ${note.creed}`, "utf8");
    } catch {
      /* ignore */
    }
  }
  return { file, indexRow: row };
}
