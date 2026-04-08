const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const IG_PROFILE_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/`;
const IG_WEB_PROFILE_INFO_URL = (username) =>
  `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
const DDIG_PROFILE_URL = (username) =>
  `https://www.ddinstagram.com/${encodeURIComponent(username)}/`;

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

    // 1) Try profile HTML with retries / UA rotation
    for (let i = 0; i < 3; i++) {
      const resp = await axios.get(url, {
        headers: {
          "User-Agent": pickUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.instagram.com/",
        },
        timeout: 20000,
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
      await sleep(500 * (i + 1));
    }

    // 2) Fallback: web_profile_info (often survives when profile HTML is 429)
    const infoResp = await axios.get(IG_WEB_PROFILE_INFO_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        "X-IG-App-ID": "936619743392459",
        Accept: "application/json",
        Referer: `https://www.instagram.com/${username}/`,
      },
      timeout: 20000,
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

    // 3) Last fallback: ddinstagram mirror.
    const ddResp = await axios.get(DDIG_PROFILE_URL(username), {
      headers: {
        "User-Agent": pickUA(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 20000,
      validateStatus: () => true,
    });

    if (ddResp.status >= 200 && ddResp.status < 300) {
      return res.json({
        success: true,
        username,
        source: "ddinstagram_mirror",
        html: typeof ddResp.data === "string" ? ddResp.data : "",
      });
    }

    return res.status(502).json({
      success: false,
      errMsg: `upstream status ${lastStatus || infoResp.status}; mirror status ${ddResp.status}`,
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

