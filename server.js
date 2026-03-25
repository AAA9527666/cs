import express from "express";
import "dotenv/config";
import axios from "axios";
import cors from "cors";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import https from "https";
import { fileURLToPath } from "url";
import { parseIptvToAppleCmsCctv, startIptvCctvScheduler } from "./iptv-cctv.js";

/* ================= 基础 ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const app = express();
const PORT = 3000;

/* ================= 日志 ================= */

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const logger = {
  info: (...m) => console.log(ts(), "[INFO]", ...m),
  warn: (...m) => console.warn(ts(), "[WARN]", ...m),
  error: (...m) => console.error(ts(), "[ERROR]", ...m),
};

/* ================= Redis ================= */

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;

const redis = new Redis(REDIS_URL, { retryStrategy: () => null });

redis.on("ready", () => logger.info("Redis 已连接:", REDIS_URL));
redis.on("error", (e) => logger.warn("Redis 异常:", e.message));

/* ================= 工具 ================= */

const readJson = (name) => {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
};

const writeJson = (name, data) => {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
};

/* ================= JWT ================= */

const JWT_SECRET = process.env.JWT_SECRET || "video-secret";
const JWT_EXPIRES_IN = "2h";

const signToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const auth = (req, res, next) => {
  const t = req.headers.authorization?.replace("Bearer ", "");
  if (!t) return res.status(401).json({ msg: "未登录" });

  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ msg: "登录已失效" });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ msg: "无管理员权限" });
  }
  next();
};

/* ================= 初始数据 ================= */

const IPTV_SOURCE_KEY = "iptv";

const buildIptvSource = () => ({
  key: IPTV_SOURCE_KEY,
  name: "CCTV 直播",
  desc: "IPTV 直播源",
  url: "/api/source/iptv",
  enabled: false,
});

const ensureIptvSource = (list) => {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!arr.some((s) => s.key === IPTV_SOURCE_KEY)) {
    arr.push(buildIptvSource());
  }
  return arr;
};

const INITIAL_SOURCES = ensureIptvSource([
  {
    key: "bdzy",
    name: "百度资源",
    desc: "默认源站",
    url: "https://api.apibdzy.com/api.php/provide/vod/from/dbm3u8/at/json/",
    enabled: true,
  },
]);

let SOURCE_CACHE = [];

/* ================= 统一密码 ================= */
const SITE_PASSWORD = "123123";

/* ================= 加载源站 ================= */

(async () => {
  const local = readJson("sources.json");
  if (local) {
    SOURCE_CACHE = ensureIptvSource(local);
    writeJson("sources.json", SOURCE_CACHE);
    logger.info("使用本地源站数据");
    return;
  }

  if (redis) {
    const r = await redis.get("video:source");
    if (r) {
      SOURCE_CACHE = ensureIptvSource(JSON.parse(r));
      writeJson("sources.json", SOURCE_CACHE);
      logger.info("从 Redis 拉取源站并缓存");
      return;
    }
  }

  SOURCE_CACHE = INITIAL_SOURCES;
  writeJson("sources.json", SOURCE_CACHE);
  logger.warn("使用默认源站数据");
})();

/* ================= 中间件 ================= */

app.use(cors());
app.use(express.json());

/* ================= IPTV(CCTV) 定时任务 → Redis ================= */

const IPTV_CCTV_URL =
  process.env.IPTV_CCTV_URL || "https://live.zbds.top/tv/iptv4.txt";
const IPTV_REFRESH_HOURS = process.env.IPTV_REFRESH_HOURS || "0";
const IPTV_REDIS_KEY = process.env.IPTV_REDIS_KEY || "video:iptv_cctv";

if (redis) {
  startIptvCctvScheduler({
    enabled: true,
    hours: IPTV_REFRESH_HOURS,
    url: IPTV_CCTV_URL,
    savePath: undefined,
    logger,
    onResult: async (data) => {
      await redis.set(IPTV_REDIS_KEY, JSON.stringify(data));
    },
  });
} else {
  logger.warn(
    "[IPTV] 未配置 Redis，CCTV 定时任务仅可通过接口即时生成，不会持久化"
  );
}

app.get("/api/iptv/cctv/refresh", auth, adminOnly, async (req, res) => {
  const r = await parseIptvToAppleCmsCctv({
    url: IPTV_CCTV_URL,
    writeToFile: false,
  });
  if (redis && r.code === 1) {
    await redis.set(IPTV_REDIS_KEY, JSON.stringify(r));
  }
  res.json(r);
});

app.get("/api/source/iptv", auth, async (req, res) => {
  try {
    let cached = null;
    if (redis) {
      const raw = await redis.get(IPTV_REDIS_KEY);
      if (raw) {
        try {
          cached = JSON.parse(raw);
        } catch {
          cached = null;
        }
      }
    }

    if (cached && cached.code === 1) {
      return res.json(cached);
    }

    const fresh = await parseIptvToAppleCmsCctv({
      url: IPTV_CCTV_URL,
      writeToFile: false,
    });
    if (redis && fresh.code === 1) {
      await redis.set(IPTV_REDIS_KEY, JSON.stringify(fresh));
    }
    res.json(fresh);
  } catch (e) {
    logger.warn("[IPTV] /api/source/iptv 异常：", e?.message || e);
    res.status(500).json({ code: 0, msg: "iptv cctv 接口异常" });
  }
});

/* ================= HTTP/HTTPS 流代理 ================= */

const PROXY_ALLOW_PRIVATE = (process.env.PROXY_ALLOW_PRIVATE || "false")
  .toLowerCase()
  .trim() === "true";

const PROXY_ALLOW_HOSTS = (process.env.PROXY_ALLOW_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const isPrivateHost = (host) => {
  const h = String(host || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h === "::1") return true;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
};

const isAllowedHost = (host) => {
  if (PROXY_ALLOW_HOSTS.length === 0) return true;
  return PROXY_ALLOW_HOSTS.some((allowed) => {
    const a = allowed.toLowerCase();
    return host.toLowerCase() === a || host.toLowerCase().endsWith(`.${a}`);
  });
};

const buildProxyUrl = (req, targetAbsUrl) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const base = `${proto}://${host}`;
  const u = new URL("/api/proxy", base);
  u.searchParams.set("url", targetAbsUrl);
  return u.toString();
};

const looksLikeM3u8 = (u, contentType = "") => {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("application/vnd.apple.mpegurl")) return true;
  if (ct.includes("application/x-mpegurl")) return true;
  const p = String(u || "").toLowerCase();
  return p.includes(".m3u8");
};

const rewriteM3u8 = ({ playlistText, playlistUrl, req }) => {
  const base = new URL(playlistUrl);
  const lines = String(playlistText || "").split(/\r?\n/);

  const out = lines.map((line) => {
    const l = line.trim();
    if (!l) return line;

    if (l.startsWith("#EXT-X-KEY")) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try {
          const abs = new URL(uri, base).toString();
          return `URI="${buildProxyUrl(req, abs)}"`;
        } catch {
          return m;
        }
      });
    }

    if (l.startsWith("#")) return line;

    try {
      const abs = new URL(l, base).toString();
      return buildProxyUrl(req, abs);
    } catch {
      return line;
    }
  });

  return out.join("\n");
};

app.get("/api/proxy", async (req, res) => {
  const raw = String(req.query.url || "");
  if (!raw) return res.status(400).send("missing url");

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).send("invalid url");
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    return res.status(400).send("unsupported protocol");
  }

  if (!PROXY_ALLOW_PRIVATE && isPrivateHost(target.hostname)) {
    return res.status(403).send("blocked host");
  }

  if (!isAllowedHost(target.hostname)) {
    return res.status(403).send("host not allowed");
  }

  try {
    const upstream = await axios.get(target.toString(), {
      responseType: "stream",
      timeout: 15000,
      maxRedirects: 3,
      headers: {
        ...(req.headers.range ? { range: req.headers.range } : {}),
        "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
        accept: req.headers.accept || "*/*",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });

    const ct = upstream.headers["content-type"] || "";

    if (looksLikeM3u8(target.toString(), ct)) {
      let buf = "";
      upstream.data.setEncoding("utf-8");
      upstream.data.on("data", (c) => (buf += c));
      upstream.data.on("end", () => {
        const rewritten = rewriteM3u8({
          playlistText: buf,
          playlistUrl: target.toString(),
          req,
        });
        res.status(upstream.status || 200);
        res.setHeader("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("cache-control", upstream.headers["cache-control"] || "no-store");
        res.send(rewritten);
      });
      upstream.data.on("error", () => res.status(502).send("upstream error"));
      return;
    }

    res.status(upstream.status || 200);
    for (const [k, v] of Object.entries(upstream.headers || {})) {
      const key = k.toLowerCase();
      if (["transfer-encoding", "content-encoding", "connection"].includes(key)) continue;
      if (v) res.setHeader(k, v);
    }
    res.setHeader("cache-control", upstream.headers["cache-control"] || "no-store");
    upstream.data.pipe(res);
  } catch (e) {
    res.status(502).send("proxy failed");
  }
});

/* ================= 登录（统一密码） ================= */

app.post("/api/login", (req, res) => {
  const { password } = req.body;

  // 统一验证一个密码
  if (password === SITE_PASSWORD) {
    return res.json({
      success: true,
      role: "user",
      token: signToken({ role: "user" }),
    });
  }

  res.status(401).json({ msg: "密码错误" });
});

/* ================= 用户接口 ================= */

app.get("/api/sources", auth, (req, res) => {
  const normalized = SOURCE_CACHE.map((s) => ({
    ...s,
    enabled: s.enabled === true,
  }));

  res.json(
    normalized
      .filter((s) => s.enabled === true)
      .map((s) => ({
        key: s.key,
        name: s.name,
        desc: s.desc,
        enabled: s.enabled,
      }))
  );
});

app.get("/api/video", auth, async (req, res) => {
  const { key, ...params } = req.query;
  const source = SOURCE_CACHE.find(
    (s) => s.key === key && s.enabled !== false
  );

  if (!source) return res.status(400).json({ msg: "无效源站" });

  try {
    const r = await axios.get(source.url, {
      params,
      timeout: 8000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ msg: "源站请求失败" });
  }
});

/* ================= 管理员接口（简化） ================= */

app.get("/api/admin/sources/redis", auth, adminOnly, async (req, res) => {
  res.json([]);
});

app.post("/api/admin/sources", auth, adminOnly, async (req, res) => {
  res.json({ success: true, msg: "ok" });
});

app.post("/api/admin/password", auth, adminOnly, async (req, res) => {
  res.json({ success: true, msg: "ok" });
});

app.post("/api/user/password", auth, adminOnly, async (req, res) => {
  res.json({ success: true, msg: "ok" });
});

// --- 静态文件 ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

/* ================= 启动 ================= */
app.listen(PORT, () => {
  logger.info(`🚀 服务已启动：http://localhost:${PORT}`);
});
