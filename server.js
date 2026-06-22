const http = require("http");
const fs = require("fs");
const path = require("path");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic();
const generate = require("./generate");

const PORT = process.env.PORT || 3456;
const DIGESTS_DIR = path.join(__dirname, "digests");
const EXPLANATIONS_PATH = path.join(__dirname, "explanations.json");

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function loadExplanations() {
  if (fs.existsSync(EXPLANATIONS_PATH)) {
    return JSON.parse(fs.readFileSync(EXPLANATIONS_PATH, "utf-8"));
  }
  return {};
}

function saveExplanations(data) {
  fs.writeFileSync(EXPLANATIONS_PATH, JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- API: list available digest dates ---
  if (url.pathname === "/api/dates" && req.method === "GET") {
    if (!fs.existsSync(DIGESTS_DIR)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("[]");
    }
    const dates = fs
      .readdirSync(DIGESTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort()
      .reverse();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(dates));
  }

  // --- API: get digest by date ---
  if (url.pathname === "/api/digest" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "date param required" }));
    }
    const fp = path.join(DIGESTS_DIR, `${date}.json`);
    if (!fs.existsSync(fp)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    const data = fs.readFileSync(fp, "utf-8");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(data);
  }

  // --- API: explain selected text ---
  if (url.pathname === "/api/explain" && req.method === "POST") {
    try {
      const { text } = JSON.parse(await readBody(req));
      if (!text || text.trim().length < 2) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "text required" }));
      }

      const key = text.trim().toLowerCase();
      const cache = loadExplanations();

      if (cache[key]) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ explanation: cache[key], cached: true }));
      }

      const message = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        output_config: { effort: "low" },
        system:
          "You are a knowledgeable AI assistant. The user has selected a piece of text from an AI industry daily digest and wants to understand it better. Provide a clear, concise explanation (2-4 sentences). If it's a person, explain who they are and why they matter. If it's a concept or term, explain it simply. If it's a quote, provide context. Be informative but brief.",
        messages: [
          { role: "user", content: `Explain this: "${text.trim()}"` },
        ],
      });

      const explanation = message.content[0].text;
      cache[key] = explanation;
      saveExplanations(cache);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ explanation, cached: false }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // --- Static files ---
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = path.join(__dirname, filePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    return fs.createReadStream(fullPath).pipe(res);
  }

  res.writeHead(404);
  res.end("Not found");
});

async function startup() {
  // Generate today's digest if needed (runs once on start)
  try {
    await generate();
  } catch (err) {
    console.error("Generate failed:", err.message);
  }

  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startup();
