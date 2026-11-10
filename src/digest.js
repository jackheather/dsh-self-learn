/**
 * 启发式摘要：本地零模型、零 token。
 * 目标：把 30 分钟直播（约 8K token）压到 1–1.5KB（约 500–700 token），
 * 只留"有信息量"的句子，并保留时间戳方便回查原文。
 */

const KEYWORDS = [
  "token", "Token", "模型", "上下文", "记忆", "技能", "场景", "规则", "工具", "接口", "API",
  "Agent", "智能体", "项目", "流程", "权限", "压缩", "索引", "笔记", "字幕", "转写", "部署",
  "服务器", "本地", "成本", "预算", "提示词", "模板", "验收", "回滚", "插件", "MCP", "工作流",
  "自动化", "脚本", "代码", "数据库", "前端", "后端", "缓存", "并发", "代理", "协议", "开源",
  "订阅", "同步", "加密", "备份", "账号", "登录", "凭据", "支付", "变现", "流量", "开源",
];

const CAUSAL = ["因为", "所以", "但是", "关键", "其实", "第一", "第二", "第三", "结论", "注意", "不要", "必须", "建议", "意味着", "本质", "核心"];

function score(text) {
  let s = 0;
  for (const k of KEYWORDS) if (text.includes(k)) s += 2;
  for (const k of CAUSAL) if (text.includes(k)) s += 1;
  if (/\d/.test(text)) s += 1;
  const len = text.length;
  if (len >= 12 && len <= 120) s += 1;
  if (len > 160) s -= 2;
  return s;
}

function splitUnits(raw) {
  const lines = String(raw).replace(/\r/g, "").split("\n");
  const units = [];
  for (const line of lines) {
    const m = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    if (m) {
      const text = m[2].trim();
      if (text) units.push({ ts: m[1], text });
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    // 无时间戳时按句号切
    for (const part of t.split(/(?<=[。！？!?])\s*/)) {
      const p = part.trim();
      if (p) units.push({ ts: "", text: p });
    }
  }
  return units;
}

function clean(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/^(嗯|啊|那个|就是说|对对对|然后呢)[，,、\s]*/g, "")
    .trim();
}

/** 开场寒暄、转场套话：信息量为零，直接丢。 */
const BOILER = /^(大家好|各位(朋友|小伙伴)|哈喽|hello|hi[，,\s]|OK[，,。\s]|那么[，,]|今天(的话)?呢?[，,]?\s*(我们|来)|本期视频|这个视频|感谢(各位|大家)|我们下(期|个视频))/i;

function isBoiler(text) {
  return BOILER.test(text);
}

export function digest(raw, opts = {}) {
  const maxLines = Number(opts.maxLines) || 26;
  const maxChars = Number(opts.maxChars) || 1400;
  const units = splitUnits(raw)
    .map((u) => ({ ...u, text: clean(u.text) }))
    .filter((u) => u.text.length >= 6 && !isBoiler(u.text));

  const scored = units.map((u, i) => ({ ...u, i, s: score(u.text) }));
  const picked = scored
    .filter((u) => u.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxLines * 2)
    .sort((a, b) => a.i - b.i);

  const seen = [];
  const out = [];
  const used = new Set();
  let chars = 0;
  const dup = (t) => seen.some((s) => s.slice(0, 10) === t.slice(0, 10));
  for (const u of picked) {
    if (dup(u.text)) continue;
    const line = `${u.ts ? `[${u.ts}] ` : ""}${u.text}`;
    if (chars + line.length > maxChars) continue;
    seen.push(u.text);
    used.add(u.i);
    out.push(line);
    chars += line.length + 1;
    if (out.length >= maxLines) break;
  }

  // 关键词命中太稀时，均匀补位：宁可多给上下文，也不要只剩两句话。
  const minLines = Number(opts.minLines) || Math.min(12, maxLines);
  if (out.length < minLines && units.length) {
    const step = Math.max(1, Math.floor(units.length / Math.max(1, minLines - out.length)));
    for (let i = 0; i < units.length && out.length < minLines; i += step) {
      const u = scored[i];
      if (!u || used.has(u.i) || dup(u.text)) continue;
      const line = `${u.ts ? `[${u.ts}] ` : ""}${u.text.slice(0, 120)}`;
      if (chars + line.length > maxChars) continue;
      seen.push(u.text);
      used.add(u.i);
      out.push(line);
      chars += line.length + 1;
    }
  }

  if (!out.length) {
    // 兜底：均匀抽样，保证至少能读到结构
    const step = Math.max(1, Math.floor(units.length / Math.min(maxLines, units.length)));
    for (let i = 0; i < units.length && out.length < maxLines; i += step) {
      const u = units[i];
      out.push(`${u.ts ? `[${u.ts}] ` : ""}${u.text.slice(0, 90)}`);
    }
  }

  return {
    text: out.join("\n"),
    stats: { units: units.length, picked: out.length, chars },
  };
}
