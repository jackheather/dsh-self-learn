/**
 * 直播守护：轮询 B 站房间 → 开播分段录制 → 录完串行转写 → 删音频。
 * 全程不调用任何模型（token 0）。
 * 用法：node daemon.mjs --data <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadLiveState, resolveConfig, saveLiveState } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] || "" : fallback;
}

const dataDir = arg("data");
if (!dataDir) {
  console.error("missing --data");
  process.exit(2);
}
const conf = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
})();
const cfg = resolveConfig({ ...conf, dataDir });
fs.mkdirSync(cfg.liveDir, { recursive: true });

const state = loadLiveState(cfg);
state.pid = process.pid;
state.startedAt = new Date().toISOString();
state.rooms ||= {};
state.queue ||= [];
const save = () => saveLiveState(cfg, state);
const logLine = (s) => {
  try {
    fs.appendFileSync(path.join(cfg.dataDir, "live.log"), `[${new Date().toISOString()}] ${s}\n`, "utf8");
  } catch {
    /* ignore */
  }
};

let running = true;
const children = new Set();

function roomUrl(roomId) {
  return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8&dolby=5`;
}

async function roomInfo(roomId) {
  const res = await fetch(roomUrl(roomId), {
    headers: {
      "user-agent": UA,
      referer: `https://live.bilibili.com/${roomId}`,
      ...(conf.cookie ? { cookie: conf.cookie } : {}),
    },
  });
  const j = await res.json();
  const d = j?.data || {};
  const live = Number(d.live_status) === 1;
  let name = d.room_info?.title || "";
  let stream = "";
  try {
    const codec = d.playurl_info?.playurl?.stream?.[0]?.format?.[0]?.codec?.[0];
    const ui = codec?.url_info?.[0];
    if (ui) stream = `${ui.host}${codec.base_url}${ui.extra}`;
  } catch {
    /* ignore */
  }
  return { live, name, stream };
}

function ffmpegRecord(stream, out, secs) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-headers",
        `Referer: https://live.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
        "-i",
        stream,
        "-t",
        String(secs),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "flac",
        out,
      ],
      { stdio: "ignore", windowsHide: true },
    );
    children.add(child);
    child.on("close", (code) => {
      children.delete(child);
      resolve(code);
    });
    child.on("error", () => {
      children.delete(child);
      resolve(-1);
    });
  });
}

function transcribe(item) {
  return new Promise((resolve) => {
    const py = conf.python || "python";
    // "-" = 正文走 stdout，由 node 写文件（python 子进程可能写不了用户目录）。
    const child = spawn(
      py,
      [path.join(HERE, "asr.py"), item.flac, "-", "--model", cfg.model, "--models", cfg.modelsDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com", PYTHONIOENCODING: "utf-8" },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    children.add(child);
    child.on("close", (code) => {
      children.delete(child);
      if (code === 0 && out.trim()) {
        try {
          fs.writeFileSync(item.out, out.endsWith("\n") ? out : out + "\n", "utf8");
        } catch (e) {
          logLine(`write ${item.out} error: ${e?.message || e}`);
          return resolve(1);
        }
      } else if (code === 0) {
        logLine(`asr empty ${item.flac}: ${err.slice(-200)}`);
        return resolve(1);
      }
      resolve(code);
    });
    child.on("error", (e) => {
      children.delete(child);
      logLine(`asr spawn error: ${e?.message || e}`);
      resolve(-1);
    });
  });
}

let transcribing = false;
async function drainQueue() {
  if (transcribing) return;
  transcribing = true;
  try {
    for (;;) {
      const item = (state.queue || []).find((x) => x.status === "pending");
      if (!item) break;
      item.status = "running";
      save();
      const code = await transcribe(item);
      item.status = code === 0 ? "done" : "error";
      item.code = code;
      save();
      if (code === 0) fs.rmSync(item.flac, { force: true });
      logLine(`transcribe ${item.flac} -> ${item.out} code=${code}`);
    }
  } finally {
    transcribing = false;
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function roomLoop(room) {
  const roomId = String(room.id);
  state.rooms[roomId] ||= { name: room.name || "", live: false, current: "" };
  let seq = Number(state.rooms[roomId].seq || 0);
  for (;;) {
    if (!running) return;
    let info;
    try {
      info = await roomInfo(roomId);
    } catch (e) {
      logLine(`room ${roomId} info error: ${e?.message || e}`);
      await sleep(60_000);
      continue;
    }
    const r = state.rooms[roomId];
    r.live = info.live;
    if (info.name) r.name = info.name;
    save();
    if (!info.live || !info.stream) {
      r.current = "";
      save();
      await sleep(60_000);
      continue;
    }
    seq += 1;
    r.seq = seq;
    const flac = path.join(cfg.liveDir, `live-${stamp()}-r${roomId}-s${String(seq).padStart(2, "0")}.flac`);
    const out = flac.replace(/\.flac$/, ".txt");
    r.current = path.basename(flac);
    save();
    logLine(`room ${roomId} recording ${path.basename(flac)}`);
    // 录制期间定时抓一帧 + 本地 OCR（0 token），整段结束就有「画面清单」。
    const framesOn = cfg.frames?.enabled !== false;
    const every = Math.max(60, Number(cfg.frames?.everySec) || 90) * 1000;
    const framesDir = path.join(cfg.framesDir, path.basename(flac).replace(/\.flac$/, ""));
    const startedAt = Date.now();
    let snapChild = null;
    let snapTimer = null;
    if (framesOn) {
      snapTimer = setInterval(() => {
        if (snapChild || !running) return;
        const at = Math.round((Date.now() - startedAt) / 1000);
        try {
          snapChild = spawn(
            process.execPath,
            [path.join(HERE, "frames.mjs"), "--video", info.stream, "--out", framesDir, "--snapshot", "--at", String(at), "--max", "1"],
            { stdio: "ignore", windowsHide: true },
          );
          snapChild.on("close", () => {
            snapChild = null;
          });
          snapChild.on("error", () => {
            snapChild = null;
          });
        } catch {
          snapChild = null;
        }
      }, every);
    }
    await ffmpegRecord(info.stream, flac, cfg.segmentSecs);
    if (snapTimer) clearInterval(snapTimer);
    const size = fs.existsSync(flac) ? fs.statSync(flac).size : 0;
    r.current = "";
    save();
    if (size > 200_000) {
      state.queue.push({ flac, out, status: "pending", at: new Date().toISOString() });
      save();
      drainQueue();
    } else {
      fs.rmSync(flac, { force: true });
      await sleep(15_000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const rooms = (conf.rooms || []).map((r) => (typeof r === "string" ? { id: r } : r)).filter((r) => r && r.id);
if (!rooms.length) {
  logLine("no rooms configured; exit");
  state.pid = 0;
  save();
  process.exit(0);
}

logLine(`daemon start pid=${process.pid} rooms=${rooms.map((r) => r.id).join(",")}`);
save();
for (const room of rooms) roomLoop(room).catch((e) => logLine(`loop crash ${room.id}: ${e?.message || e}`));

function shutdown() {
  running = false;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  state.pid = 0;
  save();
  logLine("daemon stop");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
