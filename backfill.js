// Backfill missing daily digests from the source feed repo's git history.
//
// The live feeds only expose the current day's snapshot, but the source repo
// commits each day's feed files. This script walks that history, fetches the
// feed snapshot for each missing date, and generates the digest that would
// have been produced that day.
//
// Usage:
//   node backfill.js                       # auto-detect internal gaps and fill them
//   node backfill.js 2026-06-15 2026-06-16 # backfill specific dates
const fs = require("fs");
const path = require("path");

// Load .env (same loader as generate.js)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
}

const Anthropic = require("@anthropic-ai/sdk");
const { generateDigest, pruneDigests, writeIndex, DIGESTS_DIR } = require("./generate");

const SOURCE_REPO = "zarazhangrui/follow-builders";
const FEED_FILES = { x: "feed-x.json", podcasts: "feed-podcasts.json", blogs: "feed-blogs.json" };

function ghHeaders() {
  const headers = { "User-Agent": "follow-builders-feed-backfill" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Map each calendar date (UTC) to the commit SHA that touched the feed that day.
async function buildCommitMap() {
  const url = `https://api.github.com/repos/${SOURCE_REPO}/commits?path=${FEED_FILES.x}&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub commits API failed: ${res.status} ${await res.text()}`);
  const commits = await res.json();

  const map = {};
  for (const c of commits) {
    const dateKey = c.commit.committer.date.split("T")[0];
    // Commits are returned newest-first; keep the latest commit for each day.
    if (!map[dateKey]) map[dateKey] = c.sha;
  }
  return map;
}

async function fetchFeedAtSha(sha, file) {
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${sha}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null; // file may not have existed yet
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.json();
}

async function fetchFeedsAtSha(sha) {
  const [x, podcasts, blogs] = await Promise.allSettled([
    fetchFeedAtSha(sha, FEED_FILES.x),
    fetchFeedAtSha(sha, FEED_FILES.podcasts),
    fetchFeedAtSha(sha, FEED_FILES.blogs),
  ]);
  return {
    x: x.status === "fulfilled" ? x.value : null,
    podcasts: podcasts.status === "fulfilled" ? podcasts.value : null,
    blogs: blogs.status === "fulfilled" ? blogs.value : null,
  };
}

function existingDates() {
  if (!fs.existsSync(DIGESTS_DIR)) return [];
  return fs.readdirSync(DIGESTS_DIR)
    .filter(f => f.endsWith(".json") && f !== "index.json")
    .map(f => f.replace(".json", ""));
}

// Resolve which dates to backfill. Explicit CLI dates win; otherwise fill any
// internal gap — a date with a commit that sits between existing digests but
// has no digest of its own.
function resolveTargetDates(commitMap, cliDates) {
  const have = new Set(existingDates());
  const commitDates = Object.keys(commitMap).sort();

  if (cliDates.length) {
    return cliDates.filter(d => {
      if (!commitMap[d]) {
        console.warn(`No source commit found for ${d}; skipping.`);
        return false;
      }
      if (have.has(d)) {
        console.warn(`Digest for ${d} already exists; skipping.`);
        return false;
      }
      return true;
    });
  }

  if (!have.size) return [];
  const minHave = [...have].sort()[0];
  const today = new Date().toISOString().split("T")[0];
  return commitDates.filter(d => d >= minHave && d <= today && !have.has(d));
}

async function main() {
  if (!fs.existsSync(DIGESTS_DIR)) fs.mkdirSync(DIGESTS_DIR, { recursive: true });

  const cliDates = process.argv.slice(2);
  console.log("Reading source feed commit history...");
  const commitMap = await buildCommitMap();

  const targets = resolveTargetDates(commitMap, cliDates);
  if (!targets.length) {
    console.log("No missing dates to backfill.");
    writeIndex();
    return;
  }
  console.log(`Backfilling ${targets.length} date(s): ${targets.join(", ")}`);

  const client = new Anthropic();
  let generated = 0;

  for (const date of targets) {
    const sha = commitMap[date];
    console.log(`\n=== ${date} (commit ${sha.slice(0, 9)}) ===`);
    const feeds = await fetchFeedsAtSha(sha);
    if (!feeds.x && !feeds.podcasts && !feeds.blogs) {
      console.warn(`No feed data at ${sha}; skipping ${date}.`);
      continue;
    }

    const digest = await generateDigest(feeds, client);
    // generateDigest derives the date from the feed's own generatedAt; trust
    // that for the filename, but warn if it disagrees with the commit date.
    if (digest.date !== date) {
      console.warn(`Feed generatedAt date (${digest.date}) differs from commit date (${date}).`);
    }
    const digestPath = path.join(DIGESTS_DIR, `${digest.date}.json`);
    if (fs.existsSync(digestPath)) {
      console.log(`Digest for ${digest.date} already exists; skipping write.`);
      continue;
    }
    fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2));
    console.log(`Saved ${digestPath}`);
    generated++;
  }

  pruneDigests();
  const dates = writeIndex();
  console.log(`\nBackfilled ${generated} digest(s). index.json: ${dates.join(", ")}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Backfill error:", err.message);
    process.exit(1);
  });
}

module.exports = main;
