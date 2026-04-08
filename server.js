const express = require("express");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

const IG_PROFILE_URL = (username) =>
  `https://www.instagram.com/${encodeURIComponent(username)}/`;

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
    const resp = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(502).json({
        success: false,
        errMsg: `upstream status ${resp.status}`,
      });
    }

    return res.json({
      success: true,
      username,
      html: typeof resp.data === "string" ? resp.data : "",
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

