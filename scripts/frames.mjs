/**
 * 关键帧抽取 + 本地 OCR（零 token）。
 * 用法：
 *   node frames.mjs --video <URL或本地文件> --out <目录> [--duration 秒] [--every 60] [--max 40]
 *                   [--referer https://www.bilibili.com/] [--ua Chrome] [--times 10,70,130]
 *   node frames.mjs --video <直播流URL> --out <目录> --snapshot        # 直播抓当前 1 帧
 *
 * 产出：<out>/f_<秒>_<序号>.jpg 与 <out>/frames.json
 * frames.json: [{ t, file, text }]  text 来自 Windows 自带 OCR（离线、0 token）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[k] = next;
      i++;
    } else out[k] = true;
  }
  return out;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function duration(video) {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
  const n = parseFloat(String(r.out).trim());
  return Number.isFinite(n) ? n : 0;
}

const headers = (args) =>
  `Referer: ${args.referer || "https://www.bilibili.com/"}\r\nUser-Agent: ${args.ua || UA}\r\n`;

async function grab(video, t, outFile, args, isUrl) {
  const ff = ["-hide_banner", "-loglevel", "error", "-y"];
  if (isUrl) ff.push("-headers", headers(args));
  if (t > 0) ff.push("-ss", String(t));
  ff.push("-i", video, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", outFile);
  const r = await run("ffmpeg", ff);
  return r.code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 2048;
}

async function ocr(dir, outJson) {
  const ps1 = path.join(HERE, "ocr.ps1");
  const r = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Dir", dir, "-Out", outJson]);
  if (r.code !== 0 || !fs.existsSync(outJson)) return { ok: false, err: (r.err || r.out).slice(-300) };
  return { ok: true, items: JSON.parse(fs.readFileSync(outJson, "utf8").replace(/^\uFEFF/, "")) };
}

const norm = (s) => String(s || "").replace(/\s+/g, "").slice(0, 40);

/** Windows OCR 会在汉字之间塞空格，这里压掉；英文单词之间保留一个。 */
function cleanOcr(t) {
  return String(t || "")
    .replace(/\r/g, "")
    .replace(/(?<=[\u4e00-\u9fa5，。、；：！？（）【】《》“”‘’])\s+(?=[\u4e00-\u9fa5，。、；：！？（）【】《》“”‘’])/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function selectFrames(list, max) {
  const kept = [];
  let empty = 0;
  for (const f of list) {
    const key = norm(f.text);
    if (!key) {
      if (empty >= 3) continue;
      empty++;
    } else if (kept.some((k) => norm(k.text) === key)) continue;
    kept.push(f);
    if (kept.length >= max) break;
  }
  return kept;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const video = args.video;
  const outDir = args.out;
  if (!video || !outDir) {
    console.error("用法: node frames.mjs --video <URL|文件> --out <目录> [--every 60] [--max 40] [--duration 秒]");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const isUrl = /^https?:/i.test(video);
  const max = Number(args.max) || 40;
  const every = Number(args.every) || 60;
  const snap = Boolean(args.snapshot);
  const at = Number(args.at) || 0;
  const t0 = Date.now();

  let times;
  if (snap) times = [at];
  else if (args.times) times = String(args.times).split(",").map(Number).filter(Number.isFinite);
  else {
    const dur = Number(args.duration) || (isUrl ? 0 : await duration(video));
    if (!dur) {
      console.error("拿不到时长，请传 --duration 秒");
      process.exit(3);
    }
    times = [];
    for (let t = Math.min(3, dur / 4); t < dur; t += every) times.push(Math.round(t));
    if (times.length > max) times = times.slice(0, max);
  }

  const grabbed = [];
  let idx = 0;
  for (const t of times) {
    idx++;
    const name = snap
      ? `live_${String(at).padStart(5, "0")}_${Date.now()}.jpg`
      : `f_${String(t).padStart(5, "0")}_${String(idx).padStart(3, "0")}.jpg`;
    const file = path.join(outDir, name);
    if (await grab(video, t, file, args, isUrl)) grabbed.push({ t, file: name });
  }

  let items = [];
  let ocrOk = false;
  let ocrErr = "";
  if (grabbed.length) {
    const res = await ocr(outDir, path.join(outDir, "ocr.json"));
    ocrOk = res.ok;
    ocrErr = res.err || "";
    items = res.items || [];
  }
  const byName = new Map(items.map((x) => [x.file, cleanOcr(x.text)]));
  const merged = grabbed
    .map((g) => ({ t: g.t, file: g.file, text: byName.get(g.file) || "" }))
    .sort((a, b) => a.t - b.t);
  const kept = selectFrames(merged, max);

  // 直播快照：追加进同一个 frames.json，便于整段结束后一次看完。
  const framesFile = path.join(outDir, "frames.json");
  let out = kept;
  if (snap) {
    let prev = [];
    try {
      prev = JSON.parse(fs.readFileSync(framesFile, "utf8").replace(/^\uFEFF/, "")) || [];
    } catch {
      prev = [];
    }
    const fresh = kept.filter((k) => !prev.some((p) => norm(p.text) && norm(p.text) === norm(k.text)));
    out = prev.concat(fresh).sort((a, b) => a.t - b.t);
  }
  fs.writeFileSync(framesFile, JSON.stringify(out, null, 1), "utf8");
  console.log(
    JSON.stringify({
      frames: out.length,
      grabbed: grabbed.length,
      withText: out.filter((k) => k.text).length,
      ocr: ocrOk ? "windows-ocr" : "unavailable",
      ocrError: ocrOk ? undefined : ocrErr,
      seconds: Math.round((Date.now() - t0) / 1000),
      dir: outDir,
    }),
  );
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
