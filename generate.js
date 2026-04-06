const fs = require("fs");
const path = require("path");

// Load .env file
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const Anthropic = require("@anthropic-ai/sdk");

const BASE =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main";
const FEEDS = {
  x: `${BASE}/feed-x.json`,
  podcasts: `${BASE}/feed-podcasts.json`,
  blogs: `${BASE}/feed-blogs.json`,
};
const DIGESTS_DIR = path.join(__dirname, "digests");

async function fetchJSON(url) {
  const res = await fetch(url + `?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json();
}

async function fetchFeeds() {
  const [x, podcasts, blogs] = await Promise.allSettled([
    fetchJSON(FEEDS.x),
    fetchJSON(FEEDS.podcasts),
    fetchJSON(FEEDS.blogs),
  ]);
  return {
    x: x.status === "fulfilled" ? x.value : null,
    podcasts: podcasts.status === "fulfilled" ? podcasts.value : null,
    blogs: blogs.status === "fulfilled" ? blogs.value : null,
  };
}

function getDateKey(feeds) {
  const ts =
    feeds.x?.generatedAt ||
    feeds.podcasts?.generatedAt ||
    feeds.blogs?.generatedAt ||
    "";
  return ts.split("T")[0];
}

function extractBuilders(feeds) {
  const builders = {};
  if (feeds.x && feeds.x.x) {
    for (const b of feeds.x.x) {
      builders[b.handle.toLowerCase()] = {
        name: b.name,
        handle: b.handle,
        bio: b.bio || "",
        twitter: `https://x.com/${b.handle}`,
      };
    }
  }
  if (feeds.podcasts && feeds.podcasts.podcasts) {
    for (const ep of feeds.podcasts.podcasts) {
      const key = ep.name.toLowerCase().replace(/\s+/g, "-");
      if (!builders[key]) {
        builders[key] = {
          name: ep.name,
          handle: key,
          bio: `Podcast: ${ep.title}`,
          url: ep.url || "",
        };
      }
    }
  }
  return builders;
}

function buildPrompt(feeds) {
  let content =
    "Here is today's raw feed data from AI builders. Summarize it into a polished, readable magazine-style daily digest.\n\n";

  if (feeds.x && feeds.x.x) {
    content += "=== TWEETS ===\n";
    for (const builder of feeds.x.x) {
      for (const t of builder.tweets) {
        content += `- @${builder.handle}: ${t.text}\n`;
        content += `  (${t.likes} likes, ${t.retweets} retweets)`;
        if (t.url) content += ` | Tweet: ${t.url}`;
        content += "\n\n";
      }
    }
  }

  if (feeds.podcasts && feeds.podcasts.podcasts) {
    content += "=== PODCAST EPISODES ===\n";
    for (const ep of feeds.podcasts.podcasts) {
      const transcript = ep.transcript ? ep.transcript.substring(0, 8000) : "";
      content += `Podcast: ${ep.name}\n`;
      content += `Episode: ${ep.title}\n`;
      if (ep.url) content += `Link: ${ep.url}\n`;
      content += `Transcript excerpt:\n${transcript}\n\n`;
    }
  }

  if (feeds.blogs && feeds.blogs.blogs && feeds.blogs.blogs.length) {
    content += "=== BLOG POSTS ===\n";
    for (const post of feeds.blogs.blogs) {
      const body = post.content
        ? post.content.substring(0, 5000)
        : post.description || "";
      content += `Title: ${post.title}\nAuthor: ${post.author || "unknown"}\nLink: ${post.url}\n${body}\n\n`;
    }
  }

  return content;
}

const SYSTEM_PROMPT = `You are a magazine editor producing a daily AI industry digest. Write in a sophisticated, engaging editorial voice — like reading The Economist or The Information, but warmer and more conversational.

Rules:
- Group content by THEME or TOPIC, not by source. Find the threads connecting different pieces.
- Write 3-5 thematic sections, each with a bold headline.
- Start with a 1-2 sentence editorial lead that captures the day's most important theme.
- **Quote liberally from the original sources.** Use <blockquote> to include notable direct quotes from tweets, podcast transcripts, and blog posts. Keep quotes close to the original wording — paraphrase only your editorial commentary, not the source material. Attribute quotes with the author's name or @handle.
- **Always include source links.** Link tweet URLs, podcast/video URLs, and blog post URLs inline so readers can visit the original. For podcasts/videos, use a clear label like "Watch/Listen: <a href>title</a>". For tweets, link the quoted text or author handle to the tweet URL.
- **Person links:** When mentioning a person by name or @handle, wrap it in an anchor tag with a data-handle attribute set to their lowercase Twitter handle (or a lowercase slug for non-Twitter people). Example: <a href="https://x.com/karpathy" data-handle="karpathy">Andrej Karpathy</a>. This enables rich tooltips on hover.
- Keep it concise — aim for a 3-5 minute read.
- Use HTML formatting: <h2> for section heads, <h3> for sub-topics, <p> for paragraphs, <blockquote> for quotes, <a href> for links, <strong> and <em> for emphasis, <hr> for section breaks.
- Start the output with a <p class="lead"> for the editorial lead paragraph.
- Do NOT wrap output in code blocks. Output clean HTML directly.`;

async function main() {
  // 1. Fetch feeds
  console.log("Fetching feeds...");
  const feeds = await fetchFeeds();
  const dateKey = getDateKey(feeds);
  console.log(`Feed date: ${dateKey}`);

  // 2. Check if we already have both languages for this date
  if (!fs.existsSync(DIGESTS_DIR)) fs.mkdirSync(DIGESTS_DIR);
  const digestPath = path.join(DIGESTS_DIR, `${dateKey}.json`);
  if (fs.existsSync(digestPath)) {
    const existing = JSON.parse(fs.readFileSync(digestPath, "utf-8"));
    if (existing.html_en && existing.html_zh) {
      console.log("Digest already exists for this date. Skipping.");
      return;
    }
  }

  // 3. Extract builder profiles for tooltips
  const builders = extractBuilders(feeds);

  // 4. Call Claude API for both languages
  const client = new Anthropic();
  const prompt = buildPrompt(feeds);

  console.log("Generating English digest...");
  const enMessage = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });
  const html_en = enMessage.content[0].text;

  console.log("Generating Chinese digest...");
  const zhMessage = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: SYSTEM_PROMPT + "\n\nIMPORTANT: Write the ENTIRE digest in Simplified Chinese (中文). All headlines, paragraphs, and editorial commentary must be in Chinese. Keep quotes translated to Chinese as well. Links and proper nouns (product names, company names) can remain in English.",
    messages: [{ role: "user", content: prompt }],
  });
  const html_zh = zhMessage.content[0].text;

  // 5. Save to digest.json
  const generatedAt =
    feeds.x?.generatedAt ||
    feeds.podcasts?.generatedAt ||
    feeds.blogs?.generatedAt ||
    new Date().toISOString();

  const digest = {
    date: dateKey,
    generatedAt,
    builders,
    html_en,
    html_zh,
  };

  fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2));
  console.log(`Digest saved to ${digestPath}`);

  // Prune digests older than 7 days
  const files = fs.readdirSync(DIGESTS_DIR).filter(f => f.endsWith(".json")).sort();
  while (files.length > 7) {
    const old = files.shift();
    fs.unlinkSync(path.join(DIGESTS_DIR, old));
    console.log(`Pruned old digest: ${old}`);
  }
}

// Run standalone or as module
if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

module.exports = main;
