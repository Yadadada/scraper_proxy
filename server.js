const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const IG_PROFILE_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/`;
const IG_WEB_PROFILE_INFO_URL = (username) =>
  `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
const JINA_MIRROR_URL = (username) =>
  `https://r.jina.ai/http://www.instagram.com/${encodeURIComponent(username)}/`;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
];

const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildNextDataHtmlFromWebProfileInfo = (data) => {
  const nextData = {
    props: {
      pageProps: {
        user: data && data.data ? data.data.user : null,
      },
    },
  };
  return `<!doctype html><html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData
  )}</script></body></html>`;
};

const extractCoverUrlsFromWebProfileInfo = (data, limit = 30) => {
  const out = [];
  const user = data && data.data && data.data.user;
  const media =
    user &&
    user.edge_owner_to_timeline_media &&
    user.edge_owner_to_timeline_media.edges;
  if (!Array.isArray(media)) return out;

  for (let i = 0; i < media.length && out.length < limit; i += 1) {
    const node = media[i] && media[i].node;
    if (!node || node.is_video) continue;
    // Per-post cover image only
    const u = node.display_url || node.thumbnail_src || "";
    if (!u) continue;
    out.push({
      post_id: node.shortcode || `post_${i}`,
      image_url: u,
    });
  }
  return out;
};

const extractCoverUrlsFromHtml = (html, limit = 30) => {
  if (typeof html !== "string" || !html) return [];
  const out = [];
  const seen = new Set();

  // Prefer post nodes with shortcode + display_url.
  const re = /"shortcode":"([^"]+)".{0,1200}?"display_url":"(https:[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const postId = m[1];
    const imageUrl = m[2].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    out.push({ post_id: postId, image_url: imageUrl });
  }

  // Fallback: collect display_url anyway
  if (!out.length) {
    const re2 = /"display_url":"(https:[^"]+)"/g;
    let i = 0;
    while ((m = re2.exec(html)) && out.length < limit) {
      const imageUrl = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      out.push({ post_id: `post_${i++}`, image_url: imageUrl });
    }
  }

  return out;
};

const extractCoverUrlsFromJinaText = (text, limit = 30) => {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const seen = new Set();
  const re = /https:\/\/[^"' )\]]+/g;
  let m;
  let i = 0;
  while ((m = re.exec(text)) && out.length < limit) {
    const u = m[0]
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");
    if (!u.includes("cdninstagram") && !u.includes("scontent") && !u.includes("instagram")) continue;
    if (u.includes(".mp4") || u.includes(".webm")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ post_id: `jina_${i++}`, image_url: u });
  }
  return out;
};

app.get("/healthz", (_, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.json({ success: true, ts: Date.now() });
});

// Cloud function calls this endpoint to get profile HTML.
app.get("/fetch-instagram-html", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);

  const username = String(req.query.username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

  if (!username) {
    return res.status(400).json({ success: false, errMsg: "invalid username" });
  }

  const url = IG_PROFILE_URL(username);
  try {
    let lastStatus = 0;

    // 1) Try profile HTML with limited retries / UA rotation
    for (let i = 0; i < 2; i++) {
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": pickUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.instagram.com/",
        },
        timeout: 9000,
        maxRedirects: 5,
        validateStatus: () => true,
      });

      lastStatus = resp.status;
      if (resp.status >= 200 && resp.status < 300) {
        return res.json({
          success: true,
          username,
          source: "profile_html",
          html: typeof resp.data === "string" ? resp.data : "",
        });
      }
      if (resp.status !== 429) break;
      await sleep(300 * (i + 1));
    }

    // 2) Fallback: web_profile_info (often survives when profile HTML is 429)
    const infoResp = await axios.get(IG_WEB_PROFILE_INFO_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        "X-IG-App-ID": "936619743392459",
        Accept: "application/json",
        Referer: `https://www.instagram.com/${username}/`,
      },
      timeout: 9000,
      validateStatus: () => true,
    });

    if (infoResp.status >= 200 && infoResp.status < 300 && infoResp.data) {
      const html = buildNextDataHtmlFromWebProfileInfo(infoResp.data);
      return res.json({
        success: true,
        username,
        source: "web_profile_info",
        html,
      });
    }

    // 3) Last fallback: jina mirror.
    const jinaResp = await axios.get(JINA_MIRROR_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        Accept: "text/plain,*/*;q=0.8",
      },
      timeout: 7000,
      validateStatus: () => true,
    });

    if (jinaResp.status >= 200 && jinaResp.status < 300) {
      const text = typeof jinaResp.data === "string" ? jinaResp.data : "";
      return res.json({
        success: true,
        username,
        source: "jina_mirror",
        html: `<html><body><pre>${text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre></body></html>`,
      });
    }

    return res.status(502).json({
      success: false,
      errMsg: `upstream status ${lastStatus || infoResp.status}; mirror status ${jinaResp.status}`,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      errMsg: err && err.message ? err.message : "proxy request failed",
    });
  }
});

// Lightweight endpoint: return only first image of each post (cover), not all carousel images.
app.get("/fetch-instagram-post-covers", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);

  const username = String(req.query.username || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 30)));

  if (!username) {
    return res.status(400).json({ success: false, errMsg: "invalid username" });
  }

  try {
    const infoResp = await axios.get(IG_WEB_PROFILE_INFO_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        "X-IG-App-ID": "936619743392459",
        Accept: "application/json",
        Referer: `https://www.instagram.com/${username}/`,
      },
      timeout: 9000,
      validateStatus: () => true,
    });

    if (infoResp.status >= 200 && infoResp.status < 300 && infoResp.data) {
      const covers = extractCoverUrlsFromWebProfileInfo(infoResp.data, limit);
      if (covers.length) {
        return res.json({
          success: true,
          username,
          source: "web_profile_info",
          covers,
        });
      }
    }

    // Fallback: use HTML fetch path (which itself has mirror fallbacks),
    // then extract one cover image per post.
    const htmlResp = await axios.get(
      `${req.protocol}://${req.get("host")}/fetch-instagram-html`,
      {
        params: { username },
        timeout: 22000,
        validateStatus: () => true,
      }
    );
    if (htmlResp.status >= 200 && htmlResp.status < 300 && htmlResp.data && htmlResp.data.success) {
      const html = htmlResp.data.html || "";
      const covers = extractCoverUrlsFromHtml(html, limit);
      if (covers.length) {
        return res.json({
          success: true,
          username,
          source: "html_fallback",
          covers,
        });
      }
    }

    // Last fallback: jina mirror text directly
    const jinaResp = await axios.get(JINA_MIRROR_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        Accept: "text/plain,*/*;q=0.8",
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (jinaResp.status >= 200 && jinaResp.status < 300) {
      const covers = extractCoverUrlsFromJinaText(
        typeof jinaResp.data === "string" ? jinaResp.data : "",
        limit
      );
      if (covers.length) {
        return res.json({
          success: true,
          username,
          source: "jina_text_fallback",
          covers,
        });
      }
    }

    return res.status(502).json({
      success: false,
      errMsg: `upstream status ${infoResp.status}; html status ${htmlResp.status}; jina status ${jinaResp.status}`,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      errMsg: err && err.message ? err.message : "proxy request failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`[scraper-proxy] listening on :${PORT}`);
});

