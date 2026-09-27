import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listReviewItems, resolveReviewItem } from "./review-server-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(projectRoot, "review-ui");
const distRoot = path.join(projectRoot, "dist");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml"
};

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": contentTypes[".json"], "Cache-Control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}
async function requestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Request body is too large.");
  }
  return JSON.parse(body || "{}");
}

async function serveFile(request, response, file) {
  const info = await stat(file);
  const type = contentTypes[path.extname(file)] || "application/octet-stream";
  const range = request.headers.range;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", type);

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${info.size}`
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { "Content-Length": info.size });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
}

function safeStaticPath(root, pathname, fallback = null) {
  const decoded = decodeURIComponent(pathname);
  const candidate = path.resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate.endsWith(path.sep) ? path.join(candidate, "index.html") : candidate || fallback;
}

export function createReviewServer(root = projectRoot) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && (url.pathname === "/reviews" || url.pathname === "/reviews/")) {
        return await serveFile(request, response, path.join(root, "review-ui", "index.html"));
      }
      if (request.method === "GET" && url.pathname.startsWith("/reviews/assets/")) {
        const relative = url.pathname.slice("/reviews/assets".length);
        const file = safeStaticPath(path.join(root, "review-ui"), relative);
        if (!file) return json(response, 400, { error: "Invalid path." });
        return await serveFile(request, response, file);
      }
      if (request.method === "GET" && url.pathname === "/reviews/api/items") {
        return json(response, 200, { groups: await listReviewItems(root) });
      }
      if (request.method === "PATCH" && url.pathname === "/reviews/api/items") {
        const item = await resolveReviewItem(root, await requestBody(request));
        return json(response, 200, { item });
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/reviews/audio/")) {
        const name = decodeURIComponent(url.pathname.slice("/reviews/audio/".length));
        if (!/^[a-z0-9-]+\.mp3$/.test(name)) return json(response, 400, { error: "Invalid audio path." });
        return await serveFile(request, response, path.join(root, "processing", name));
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const requested = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = safeStaticPath(path.join(root, "dist"), requested);
        if (file) return await serveFile(request, response, file);
      }
      json(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error?.code === "ENOENT" ? 404 : 400;
      json(response, status, { error: error.message || "Request failed." });
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  createReviewServer().listen(port, "127.0.0.1", () => {
    console.log(`Wait, What? local server: http://127.0.0.1:${port}`);
    console.log(`Human review route:       http://127.0.0.1:${port}/reviews`);
  });
}
