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

// 默认尝试连接本机 Redis，除非显式覆盖 REDIS_URL
const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0";
const REDIS_URL = process.env.REDIS_URL || DEFAULT_REDIS_URL;

if (!process.env.REDIS_URL) {
  logger.warn(
    "未显式配置 REDIS_URL，使用默认 Redis 配置：",
    DEFAULT_REDIS_URL
  );
}

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
let USER_PASSWORD = null;

/* ================= 管理员密码 ================= */

let ADMIN_PASSWORD = readJson("admin.json")?.password;

if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString("hex");
  writeJson("admin.json", { password: ADMIN_PASSWORD });
  logger.warn("⚠️ 管理员密码已生成：", ADMIN_PASSWORD);
}

/* ================= 加载用户密码 ================= */

(async () => {
  const local = readJson("password.json");
  if (local?.password) {
    USER_PASSWORD = local.password;
    return;
  }

  if (redis) {
    const r = await redis.get("video:password");
    if (r) {
      USER_PASSWORD = r;
      writeJson("password.json", { password: r });
    }
  }
})();

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
    // 定时任务只写 Redis，不再写本地 JSON
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

// 管理员手动刷新一次，并写入 Redis（如果存在）
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

// 作为“第三方源”的 Apple CMS 风格接口，前端/后台可当作普通 sources 使用
// 仅在携带有效 Authorization token 时可访问
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

    // 没有缓存时临时抓一次（不会写本地 JSON）
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

/* ================= HTTP/HTTPS 流代理（解决 https 页面播放 http 资源） ================= */

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

    // EXT-X-KEY:URI="..."
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

    // 非注释行视为 URI（分片/子清单）
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
        // 透传 Range（HLS 分片常用）
        ...(req.headers.range ? { range: req.headers.range } : {}),
        "user-agent":
          req.headers["user-agent"] ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) movie-app/proxy",
        accept: req.headers.accept || "*/*",
      },
      // 允许抓取自签名 https 源（部分直播源会这样）
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
    });

    const ct = upstream.headers["content-type"] || "";

    // m3u8 需要改写内部链接为 /api/proxy?url=...
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
        res.setHeader(
          "content-type",
          "application/vnd.apple.mpegurl; charset=utf-8"
        );
        if (upstream.headers["cache-control"]) {
          res.setHeader("cache-control", upstream.headers["cache-control"]);
        } else {
          res.setHeader("cache-control", "no-store");
        }
        res.send(rewritten);
      });
      upstream.data.on("error", () => res.status(502).send("upstream error"));
      return;
    }

    // 其他内容直接透传（ts/mp4/key 等）
    res.status(upstream.status || 200);
    for (const [k, v] of Object.entries(upstream.headers || {})) {
      const key = k.toLowerCase();
      if (
        key === "transfer-encoding" ||
        key === "content-encoding" ||
        key === "connection"
      ) {
        continue;
      }
      if (typeof v !== "undefined") res.setHeader(k, v);
    }
    res.setHeader("cache-control", upstream.headers["cache-control"] || "no-store");
    upstream.data.pipe(res);
  } catch (e) {
    res.status(502).send("proxy failed");
  }
});

/* ================= 登录 ================= */

app.post("/api/login", (req, res) => {
  const { password } = req.body;

  if (password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      role: "admin",
      token: signToken({ role: "admin" }),
      needSetUserPassword: !USER_PASSWORD,
    });
  }

  if (USER_PASSWORD && password === USER_PASSWORD) {
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
  // 统一规范 enabled 字段：只有显式为 true 才视为启用，其余一律 false
  const normalized = SOURCE_CACHE.map((s) => ({
    ...s,
    enabled: s.enabled === true,
  }));

  // 如果是管理员，返回所有源站和完整字段（包含 url 和 enabled）
  if (req.user.role === "admin") {
    return res.json(normalized);
  }

  // 普通用户只返回启用的源站和基本字段（不暴露 url）
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

/* ================= 管理员接口 ================= */

app.get("/api/admin/sources/redis", auth, adminOnly, async (req, res) => {
  if (!redis) {
    return res.json([]);
  }

  try {
    const data = await redis.get("video:source");
    if (!data) return res.json([]);

    const sources = JSON.parse(data).map((s) => ({
      ...s,
      // Redis 可能没有 enable 字段，默认启用
      enabled: s.enabled === false ? false : true,
      // 确保 url 字段存在，默认为空字符串
      url: s.url || "",
      // 确保 name 和 key 字段存在
      name: s.name || "",
      key: s.key || ""
    }));

    res.json(sources);
  } catch (err) {
    logger.error("从 Redis 拉取源站失败:", err.message);
    res.status(500).json({ msg: "拉取源站数据失败" });
  }
});


app.post("/api/admin/sources", auth, adminOnly, async (req, res) => {
  const { sources, syncToRedis = false } = req.body;
  if (!Array.isArray(sources)) {
    return res.status(400).json({ msg: "源站数据格式错误" });
  }

  // 固定 IPTV 源（key=iptv）始终存在，默认禁用，可在后台启用/排序，但不能真正删除
  const finalSources = ensureIptvSource(sources);

  SOURCE_CACHE = finalSources;
  writeJson("sources.json", finalSources);

  if (syncToRedis && redis) {
    await redis.set("video:source", JSON.stringify(finalSources));
  }

  res.json({ success: true, msg: "源站已保存" });
});

// 更新管理员密码
app.post("/api/admin/password", auth, adminOnly, async (req, res) => {
  const { password } = req.body;

  if (!password || password === ADMIN_PASSWORD) {
    return res.status(400).json({ msg: "管理员密码不合法" });
  }

  ADMIN_PASSWORD = password;
  writeJson("admin.json", { password });

  res.json({ success: true, msg: "管理员密码已更新" });
});

// 更新用户访问密码
app.post("/api/user/password", auth, adminOnly, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ msg: "用户密码不合法" });
  }

  USER_PASSWORD = password;
  writeJson("password.json", { password });

  if (redis) await redis.set("video:password", password);

  res.json({ success: true, msg: "用户密码已设置" });
});

// --- 静态文件服务 (可选) ---
// 如果你打包了 React 项目 (npm run build)，将 dist 目录放在 server.js 同级
app.use(express.static(path.join(__dirname, 'dist')));

// SPA 路由支持：任何未处理的请求返回 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

/* ================= 启动 ================= */
app.listen(PORT, () => {
  logger.info(`🚀 服务已启动：http://localhost:${PORT}`);
  logger.info(`👉 接口地址: http://localhost:${PORT}/api/video`);

});
