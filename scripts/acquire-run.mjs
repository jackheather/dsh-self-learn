/**
 * 单来源采集 runner（后台进程；不调用任何模型）。
 * 用法：node acquire-run.mjs --data <dir> --source <BV|URL|path>
 */
import fs from "node:fs";
import path from "node:path";

import { acquire } from "../src/acquire.js";
import { loadRegistry, resolveConfig, saveRegistry, sourceId } from "../src/store.js";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] || "" : fallback;
}

const dataDir = arg("data");
const source = arg("source");
const title = arg("title");
if (!dataDir || !source) {
  console.error("missing --data/--source");
  process.exit(2);
}

const confFile = path.join(dataDir, "config.json");
let conf = {};
try {
  conf = JSON.parse(fs.readFileSync(confFile, "utf8").replace(/^\uFEFF/, ""));
} catch {
  conf = {};
}
const cfg = resolveConfig({ ...conf, dataDir });
fs.mkdirSync(cfg.transcriptDir, { recursive: true });
fs.mkdirSync(cfg.tmpDir, { recursive: true });

const id = sourceId(source);
const reg = loadRegistry(cfg);
reg[id] = { ...(reg[id] || {}), id, ref: source, title: title || reg[id]?.title || source, status: "queued", at: new Date().toISOString() };
saveRegistry(cfg, reg);

try {
  const info = await acquire(cfg, source, (a, b) => {
    const tail = String(b || a || "").slice(-300);
    if (tail) fs.appendFileSync(path.join(cfg.dataDir, "acquire.log"), `[${new Date().toISOString()}] ${tail}\n`, "utf8");
  });
  const reg2 = loadRegistry(cfg);
  reg2[info.id] = {
    ...(reg2[info.id] || {}),
    ...info,
    title: title || info.title,
    status: "ready",
    at: new Date().toISOString(),
  };
  saveRegistry(cfg, reg2);
  fs.appendFileSync(path.join(cfg.dataDir, "acquire.log"), `[${new Date().toISOString()}] OK ${info.id} ${info.chars} chars\n`, "utf8");
  console.log("OK", info.id, info.chars);
} catch (e) {
  const reg2 = loadRegistry(cfg);
  reg2[id] = { ...(reg2[id] || { id, ref: source }), status: "error", error: String(e?.message || e) };
  saveRegistry(cfg, reg2);
  fs.appendFileSync(path.join(cfg.dataDir, "acquire.log"), `[${new Date().toISOString()}] ERR ${id} ${e?.message || e}\n`, "utf8");
  console.error("ERR", e?.message || e);
  process.exit(1);
}
