import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GENRE_MAP = {
  央视频道: 1,
  卫视频道: 2,
  电影频道: 3,
  数字频道: 4,
  儿童频道: 5,
  地方频道: 6,
  纪录频道: 7,
  体育频道: 8,
  解说频道: 9,
  音乐频道: 10,
  春晚频道: 11,
  直播中国: 12,
};

// 屏蔽的播放地址黑名单（包含以下串的 URL 会被丢弃）
const BLACK_PLAYURL_LIST = [
  "222.174.161.168",
];

const normalizeGenre = (g) =>
  String(g || "其他")
    .trim()
    .replace(/[，,]+$/g, "")
    .trim() || "其他";

function toAppleCms({ channels }) {
  const list = [];
  let vod_id = 1;

  for (const [channelName, info] of Object.entries(channels)) {
    const { genre, type_id, urls } = info;
    if (!channelName || !urls?.length) continue;

    // 播放地址：
    // - https:// 开头的：保留为协议相对地址（//host/...），不走代理
    // - 其他 http 源：统一通过 /api/proxy 转发，避免 https 页面对接 http 源
    const playUrls = urls
      .map((u, idx) => {
        let target = u;
        if (u.startsWith("https://")) {
          // 协议相对地址，前端在 https 页面会自动以 https 访问
          target = u.replace(/^https:/, "");
        } else {
          target = `/api/proxy?url=${encodeURIComponent(u)}`;
        }
        return `源${idx + 1}$${target}`;
      })
      .join("#");

    const svgText = `${channelName};${genre}`.replaceAll(" ", "+");
    const vod_pic = `https://readme-typing-svg.herokuapp.com/?font=Sekuya&weight=900&pause=500&color=ff0000&background=000000&center=true&vCenter=true&width=270&height=360&lines=${svgText}`;

    list.push({
      vod_id,
      vod_name: channelName,
      vod_sub: genre,
      vod_en: channelName.toLowerCase().replaceAll(" ", "_"),
      vod_letter: channelName?.[0]?.toUpperCase?.() || "C",
      vod_color: "",
      vod_tag: "IPTV;CCTV",
      vod_class: genre,
      vod_pic,
      vod_pic_thumb: vod_pic,
      vod_pic_slide: "",
      vod_pic_screenshot: "",
      vod_actor: "",
      vod_director: "",
      vod_writer: "",
      vod_behind: "",
      vod_blurb: `CCTV 直播频道 - ${genre} - 共${urls.length}个播放源`,
      vod_remarks: "2026",
      vod_pubdate: "",
      vod_total: urls.length,
      vod_serial: "直播中",
      vod_tv: channelName,
      vod_weekday: "",
      vod_area: "中国大陆",
      vod_lang: "中文",
      vod_year: "2026",
      vod_version: "高清",
      vod_state: "直播",
      vod_author: "",
      vod_jumpurl: "",
      vod_tpl: "",
      vod_tpl_play: "",
      vod_tpl_down: "",
      vod_isend: 0,
      vod_lock: 0,
      vod_level: 0,
      vod_copyright: 0,
      vod_points: 0,
      vod_points_play: 0,
      vod_points_down: 0,
      vod_hits: 0,
      vod_hits_day: 0,
      vod_hits_week: 0,
      vod_hits_month: 0,
      vod_duration: "",
      vod_up: 0,
      vod_down: 0,
      vod_score: "9.0",
      vod_score_all: 0,
      vod_score_num: 0,
      vod_time: "",
      vod_time_add: 0,
      vod_time_hits: 0,
      vod_time_make: 0,
      vod_trysee: 0,
      vod_douban_id: 0,
      vod_douban_score: "9.0",
      vod_content: `包含播放源：${urls
        .map((_, idx) => `源${idx + 1}`)
        .join(", ")}`,
      vod_play_from: "m3u8",
      vod_play_server: "iptv",
      vod_play_note: `CCTV 多源直播（共${urls.length}个源）`,
      vod_play_url: playUrls,
      vod_down_from: "",
      vod_down_server: "",
      vod_down_note: "",
      vod_down_url: "",
      vod_plot: 0,
      vod_plot_name: "",
      vod_plot_detail: "",
      type_id,
      type_id_1: type_id,
      group_id: 0,
      type_name: genre,
      vod_status: 1,
    });

    vod_id += 1;
  }

  return {
    code: 1,
    msg: "success",
    page: 1,
    pagecount: 1,
    limit: String(list.length),
    total: list.length,
    list,
  };
}

export async function parseIptvToAppleCmsCctv({
  url = "https://live.zbds.top/tv/iptv4.txt",
  savePath,
  requestTimeoutMs = 15000,
  writeToFile = false,
} = {}) {
  const absSavePath =
    savePath && (path.isAbsolute(savePath)
      ? savePath
      : path.join(__dirname, savePath));

  let text = "";
  try {
    const resp = await axios.get(url, {
      timeout: requestTimeoutMs,
      responseType: "text",
      transformResponse: (r) => r,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) movie-app/iptv-cctv",
      },
    });
    text = String(resp.data || "");
  } catch (e) {
    return {
      code: 0,
      msg: `请求失败：${e?.message || String(e)}`,
      page: 1,
      pagecount: 0,
      limit: "20",
      total: 0,
      list: [],
    };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());

  let current_genre = "其他";
  let current_type_id = 99;

  /** @type {Record<string, {genre: string, type_id: number, urls: string[]}>} */
  const channels = {};

  for (const line of lines) {
    if (!line) continue;

    if (line.includes("#genre#")) {
      current_genre = normalizeGenre(line.replace("#genre#", ""));
      current_type_id = GENRE_MAP[current_genre] ?? 99;
      continue;
    }

    const idx = line.indexOf(",");
    if (idx === -1) continue;

    const channelName = line.slice(0, idx).trim();
    const playUrl = line.slice(idx + 1).trim();

    if (!channelName.toUpperCase().startsWith("CCTV")) continue;
    if (!playUrl.startsWith("http")) continue;

    // 播放地址黑名单过滤
    if (BLACK_PLAYURL_LIST.some((kw) => playUrl.includes(kw))) continue;

    if (!channels[channelName]) {
      channels[channelName] = {
        genre: current_genre,
        type_id: current_type_id,
        urls: [],
      };
    } else {
      if (channels[channelName].genre !== current_genre) {
        channels[channelName].genre = current_genre;
        channels[channelName].type_id = current_type_id;
      }
    }

    if (!channels[channelName].urls.includes(playUrl)) {
      channels[channelName].urls.push(playUrl);
    }
  }

  const result = toAppleCms({ channels });

  if (writeToFile && absSavePath) {
    fs.mkdirSync(path.dirname(absSavePath), { recursive: true });
    fs.writeFileSync(absSavePath, JSON.stringify(result, null, 2), "utf-8");
  }

  return result;
}

export function startIptvCctvScheduler({
  enabled = true,
  hours = 0,
  url,
  savePath,
  logger = console,
  onResult,
} = {}) {
  const parsedHours = Number(hours);
  const intervalMs =
    Number.isFinite(parsedHours) && parsedHours > 0
      ? parsedHours * 60 * 60 * 1000
      : 0;

  if (!enabled || intervalMs <= 0) return { stop: () => {} };

  let stopped = false;

  const runOnce = async () => {
    try {
      const r = await parseIptvToAppleCmsCctv({
        url,
        savePath,
        writeToFile: Boolean(savePath),
      });
      if (r.code === 1) {
        logger.info?.(
          `[IPTV] CCTV 刷新成功：total=${r.total}，已写入 ${savePath}`
        );
        if (typeof onResult === "function") {
          try {
            await onResult(r);
          } catch (e) {
            logger.warn?.(
              `[IPTV] CCTV onResult 异常：${e?.message || String(e)}`
            );
          }
        }
      } else {
        logger.warn?.(`[IPTV] CCTV 刷新失败：${r.msg}`);
      }
    } catch (e) {
      logger.warn?.(`[IPTV] CCTV 刷新异常：${e?.message || String(e)}`);
    }
  };

  // 启动后立刻跑一次，再进入周期
  void runOnce();

  const loop = async () => {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;
      await runOnce();
    }
  };
  void loop();

  return { stop: () => (stopped = true) };
}

