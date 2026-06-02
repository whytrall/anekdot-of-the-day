const express = require("express");
const crypto = require("crypto");
const sharp = require("sharp");
const stirlitzJokes = require("./stirlitz.json");
const allJokes = require("./jokes.json");

const app = express();
const PORT = process.env.PORT || 3000;

const CACHE_TTL = 5_000;

// --- Image generation helpers ---

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}

function wrapText(text, maxChars) {
  const lines = [];
  for (const para of text.split("\n")) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= maxChars) {
        line += " " + word;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function generateJokeImage(jokeText, label = "Случайный анекдот:") {
  const W = 200, PAD = 12, FS = 13, LH = 20;
  const LABEL_FS = 10, LABEL_H = 16;
  const CHARS_PER_LINE = 22;

  const lines = wrapText(jokeText, CHARS_PER_LINE);
  const height = PAD + LABEL_H + lines.length * LH + PAD;

  const labelNode =
    `<text x="${PAD}" y="${PAD + LABEL_FS}" ` +
    `font-family="DejaVu Sans,Liberation Sans,sans-serif" ` +
    `font-size="${LABEL_FS}" fill="#999999">${escapeXml(label)}</text>`;

  const textNodes = lines
    .map(
      (l, i) =>
        `<text x="${PAD}" y="${PAD + LABEL_H + i * LH + FS}" ` +
        `font-family="DejaVu Sans,Liberation Sans,sans-serif" ` +
        `font-size="${FS}" fill="#1a1a1a">${escapeXml(l)}</text>`
    )
    .join("\n  ");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}">` +
    `<rect width="${W}" height="${height}" fill="white"/>` +
    `${labelNode}${textNodes}</svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

// --- Page renderers ---

function renderPage(jokeHtml, href = "/", nonce = "") {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Анекдот дня</title>
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body { height: auto; overflow: hidden; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: transparent;
      color: #1a1a1a;
      padding: 10px;
    }

    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #e8e8e8; }
    }

    .card {
      max-width: 600px;
      text-align: left;
    }

    .joke {
      font-size: 16px;
      line-height: 1.6;
      white-space: normal;
    }

    .actions {
      margin-top: 8px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }

    .btn {
      display: inline-block;
      padding: 6px 16px;
      font-size: 13px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: filter 0.2s;
    }

    .btn:hover { filter: brightness(0.85); }

</style>
</head>
<body>
  <div class="card">
    <div class="joke">${jokeHtml}</div>
    <div class="actions">
      <a class="btn" id="btn" href="${href}">Ещё анекдот</a>
    </div>
  </div>
  <script nonce="${nonce}">
    (function() {
      var h = Math.floor(Math.random() * 360);
      var s = 55 + Math.floor(Math.random() * 30);
      var l = 40 + Math.floor(Math.random() * 20);
      var btn = document.getElementById("btn");
      btn.style.background = "hsl(" + h + "," + s + "%," + l + "%)";
      btn.style.color = l < 55 ? "#fff" : "#1a1a1a";
    })();
  </script>
</body>
</html>`;
}

// --- Middleware ---

app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.nonce = nonce;
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors *`
  );
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Routes ---

function htmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let imgCache = { buf: null, ts: 0 };
let stirlitzImgCache = { buf: null, ts: 0 };

app.get("/joke.jpg", async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /joke.jpg`);
  const now = Date.now();

  if (imgCache.buf && now - imgCache.ts < CACHE_TTL) {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL / 1000}`);
    return res.send(imgCache.buf);
  }

  try {
    const jokeHtml = randomItem(allJokes);
    const jokeText = htmlToText(jokeHtml);
    const buf = await generateJokeImage(jokeText);
    imgCache = { buf, ts: now };
    console.log(
      `[${new Date().toISOString()}] Generated joke image (${buf.length} bytes)`
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL / 1000}`);
    res.send(buf);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed to generate joke image:`,
      err.message
    );
    res.status(500).type("text").send("Ошибка сервера");
  }
});

app.get("/joke.json", (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /joke.json`);
  const jokeHtml = randomItem(allJokes);
  res.json({ html: jokeHtml, text: htmlToText(jokeHtml) });
});

app.get("/stirlitz.json", (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /stirlitz.json`);
  const joke = randomItem(stirlitzJokes);
  res.json({ text: joke });
});

app.get("/stirlitz", (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /stirlitz`);
  const joke = randomItem(stirlitzJokes);
  res.send(renderPage(htmlEscape(joke), "/stirlitz", res.locals.nonce));
});

app.get("/stirlitz.jpg", async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /stirlitz.jpg`);
  const now = Date.now();

  if (stirlitzImgCache.buf && now - stirlitzImgCache.ts < CACHE_TTL) {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL / 1000}`);
    return res.send(stirlitzImgCache.buf);
  }

  try {
    const joke = randomItem(stirlitzJokes);
    const buf = await generateJokeImage(joke, "Случайный анекдот про Штирлица:");
    stirlitzImgCache = { buf, ts: now };
    console.log(
      `[${new Date().toISOString()}] Generated stirlitz image (${buf.length} bytes)`
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL / 1000}`);
    res.send(buf);
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Failed to generate stirlitz image:`,
      err.message
    );
    res.status(500).type("text").send("Ошибка сервера");
  }
});

app.get("/", (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /`);
  const joke = randomItem(allJokes);
  console.log(`[${new Date().toISOString()}] Serving joke (${joke.length} chars)`);
  res.send(renderPage(joke, "/", res.locals.nonce));
});

app.listen(PORT, () => {
  console.log(`Anekdot server running at http://localhost:${PORT}`);
});
