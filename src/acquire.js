import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseBv, isUrl, sourceId, hashId } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

async function jsonFetch(url, cfg) {
  const headers = {
    "user-agent": UA,
    referer: "https://www.bilibili.com/",
    accept: "application/json, text/plain, */*",
  };
  if (cfg.cookie) headers.cookie = cfg.cookie;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function pickAudio(data) {
  const audios = data?.dash?.audio || [];
  if (!audios.length) return null;
  return audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

function pickVideo(data) {
  const videos = data?.dash?.video || [];
  if (!videos.length) return null;
  return videos.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

/** 抽关键帧 + 本地 OCR；失败不阻断主流程（转写才是主产物）。 */
async function extractFrames(cfg, videoUrl, duration, outDir, log) {
  const f = cfg.frames || {};
  if (!f.enabled) return null;
  const r = await run(process.execPath, [
    path.join(HERE, "..", "scripts", "frames.mjs"),
    "--video",
    videoUrl,
    "--out",
    outDir,
    "--duration",
    String(duration || 0),
    "--every",
    String(f.everySec || 90),
    "--max",
    String(f.max || 40),
  ]);
  if (log) log(r.out, r.err);
  try {
    return JSON.parse(String(r.out).trim().split("\n").pop());
  } catch {
    return { frames: 0, error: String(r.err || r.out).slice(-200) };
  }
}

async function asr(cfg, flac, outTxt, log) {
  const py = cfg.python || "python";
  const script = path.join(HERE, "..", "scripts", "asr.py");
  const r = await run(py, [script, flac, outTxt, "--model", cfg.model, "--models", cfg.modelsDir], {
    env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com", PYTHONIOENCODING: "utf-8" },
  });
  if (log) log(r.out, r.err);
  if (r.code !== 0) throw new Error(`ASR 失败（${py}）：${(r.err || r.out).slice(-400)}`);
}

async function acquireBili(cfg, input, log) {
  const bv = parseBv(input);
  if (!bv) throw new Error("不是有效的 BV 号或视频链接");
  const view = await jsonFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, cfg);
  if (view.code !== 0) throw new Error(`view 接口 ${view.code} ${view.message || ""}`);
  const info = view.data;
  const cid = info.pages?.[0]?.cid;
  if (!cid) throw new Error("拿不到 cid");
  const play = await jsonFetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${cid}&qn=64&fnval=16&fourk=1`,
    cfg,
  );
  if (play.code !== 0) throw new Error(`playurl 接口 ${play.code} ${play.message || ""}（可能需要 cookie）`);
  const audio = pickAudio(play.data);
  if (!audio) throw new Error("没有可用的音频流（可能是付费/充电视频）");
  const tmpFlac = path.join(cfg.tmpDir, `${bv}.flac`);
  const r = await run("ffmpeg", [
    "-y",
    "-headers",
    `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
    "-i",
    audio.baseUrl,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    tmpFlac,
  ]);
  if (log) log(r.out, r.err);
  if (r.code !== 0 || !fs.existsSync(tmpFlac)) throw new Error("下载音频失败（ffmpeg 未安装或流地址过期）");
  const outTxt = path.join(cfg.transcriptDir, `${bv}.txt`);
  await asr(cfg, tmpFlac, outTxt, log);
  fs.rmSync(tmpFlac, { force: true });
  const text = fs.readFileSync(outTxt, "utf8");

  // 画面：视频流直接按时间点抓帧（不下载整段视频），再本地 OCR。
  let framesInfo = null;
  let framesDir = "";
  const video = pickVideo(play.data);
  if (video && info.duration) {
    framesDir = path.join(cfg.framesDir, bv);
    framesInfo = await extractFrames(cfg, video.baseUrl, info.duration, framesDir, log);
  }

  return {
    id: "bili:" + bv,
    type: "bili",
    ref: `https://www.bilibili.com/video/${bv}`,
    title: info.title || bv,
    transcriptPath: outTxt,
    framesDir: framesInfo?.frames ? framesDir : "",
    frames: framesInfo?.frames || 0,
    chars: text.length,
    extra: { bv, author: info.owner?.name, duration: info.duration, frames: framesInfo?.frames || 0 },
  };
}

async function acquireWeb(cfg, url, log) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let html = await res.text();
  if (html.length > cfg.maxWebChars) html = html.slice(0, cfg.maxWebChars);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url).trim();
  const text = htmlToText(html);
  if (text.length < 200) throw new Error("抓到的正文太短（可能是 JS 渲染页，需要浏览器）");
  const id = "web:" + hashId(url);
  const outTxt = path.join(cfg.transcriptDir, `${id.replace(":", "_")}.txt`);
  fs.writeFileSync(outTxt, text, "utf8");
  if (cfg.cookie) {
    /* web 抓取不使用 bili cookie */
  }
  void log;
  return { id, type: "web", ref: url, title, transcriptPath: outTxt, chars: text.length, extra: {} };
}

function docxText(file, cfg) {
  const tmp = path.join(cfg.tmpDir, `docx-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zip = path.join(tmp, "doc.zip");
  fs.copyFileSync(file, zip);
  const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`;
  return run("powershell", ["-NoProfile", "-Command", ps]).then((r) => {
    const xmlPath = path.join(tmp, "word", "document.xml");
    if (r.code !== 0 || !fs.existsSync(xmlPath)) {
      throw new Error("docx 解压失败（需要 Windows PowerShell 的 Expand-Archive）");
    }
    const xml = fs.readFileSync(xmlPath, "utf8");
    return xml
      .replace(/<w:p[ >]/g, "\n<w:p ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .trim();
  });
}

async function acquireFile(cfg, p, log) {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (/\.(md|txt|html?|json|csv)$/i.test(ent.name)) files.push(full);
      }
    };
    walk(abs, 0);
    const picked = files.slice(0, cfg.maxDirFiles);
    let text = `# 目录：${abs}\n\n（共 ${files.length} 个可读文件，取前 ${picked.length} 个）\n`;
    for (const f of picked) {
      const body = fs.readFileSync(f, "utf8").slice(0, cfg.maxFileBytes);
      text += `\n\n<!-- ${path.relative(abs, f)} -->\n${body}`;
    }
    const id = "file:" + hashId(abs);
    const outTxt = path.join(cfg.transcriptDir, `${id.replace(":", "_")}.txt`);
    fs.writeFileSync(outTxt, text, "utf8");
    return { id, type: "dir", ref: abs, title: path.basename(abs), transcriptPath: outTxt, chars: text.length, extra: { files: picked.length } };
  }
  if (st.size > 20 * 1024 * 1024) throw new Error("文件过大（>20MB）");
  const ext = path.extname(abs).toLowerCase();
  let text = "";
  if (ext === ".docx") text = await docxText(abs, cfg);
  else if (ext === ".pdf") {
    const py = cfg.python || "python";
    const r = await run(py, ["-c", `import sys;
try:
    from pypdf import PdfReader
except Exception:
    from PyPDF2 import PdfReader
r=PdfReader(sys.argv[1])
print("\\n".join((p.extract_text() or "") for p in r.pages))`, abs]);
    if (r.code !== 0) throw new Error("PDF 需要 pypdf（pip install pypdf）或 pdftotext");
    text = r.out;
  } else if (/\.(html?)$/i.test(ext)) text = htmlToText(fs.readFileSync(abs, "utf8"));
  else text = fs.readFileSync(abs, "utf8");
  if (text.length > cfg.maxFileBytes) text = text.slice(0, cfg.maxFileBytes) + "\n…（已截断）";
  const id = "file:" + hashId(abs);
  const outTxt = path.join(cfg.transcriptDir, `${id.replace(":", "_")}.txt`);
  fs.writeFileSync(outTxt, text, "utf8");
  if (log) log(`file ${ext} ${text.length} chars`);
  return { id, type: "file", ref: abs, title: path.basename(abs), transcriptPath: outTxt, chars: text.length, extra: {} };
}

export async function acquire(cfg, input, log = () => {}) {
  const s = String(input ?? "").trim();
  if (!s) throw new Error("缺少来源：BV 号 / http(s) 链接 / 本地文件或目录路径");
  if (parseBv(s) || /bilibili\.com\/video/i.test(s)) return acquireBili(cfg, s, log);
  if (isUrl(s)) return acquireWeb(cfg, s, log);
  if (!fs.existsSync(s)) throw new Error(`路径不存在：${s}`);
  return acquireFile(cfg, s, log);
}

export { sourceId };
