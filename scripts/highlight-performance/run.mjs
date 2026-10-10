import { build } from "../../node_modules/vite/dist/node/index.js";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(sourceDir, "../..");
const dir = path.join(root, ".tools/highlight-perf");
await mkdir(dir, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MD_READER_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const phase = process.argv[2] || "after";
if (!["before", "after", "regression"].includes(phase)) throw new Error("Usage: node scripts/highlight-performance/run.mjs before|after|regression [baseline git ref]");
const baselineRef = process.argv[3] || "94f315d3c8648b320e214862e75fd678dc49017f";
const baselineFiles = new Map();
if (phase === "before") {
  for (const file of ["src/App.tsx", "src/components/EditWorkspace.tsx", "src/components/CodeBlock.tsx", "src/components/MarkdownView.tsx", "src/hooks/useDocumentSearch.ts", "src/index.css"]) {
    baselineFiles.set(file, execFileSync("git", ["show", `${baselineRef}:${file}`], { cwd: root, encoding: "utf8" }));
  }
}
setTimeout(()=>{ console.error("Test watchdog expired"); process.exit(1); },160000).unref();
const paragraphs = "Representative performance document: ordinary prose, punctuation, and navigation text. ".repeat(5);
const content = Array.from({ length: 120 }, (_, i) => `## Section ${i + 1}\n\n${paragraphs}\n\n\`\`\`ts\nconst searchable${i} = "needle-${i}";\n${Array.from({ length: 16 }, (_, j) => `const item${j} = { id: ${j}, text: "sample", active: true };`).join("\n")}\n\`\`\`\n\n`).join("");
await writeFile(path.join(dir, "representative.md"), content);
await build({ configFile: false, root, logLevel: "error", plugins: [{ name: "measure", enforce: "pre", transform(src, id) {
  const file = id.replaceAll("\\", "/").slice(root.replaceAll("\\", "/").length + 1);
  src = baselineFiles.get(file) ?? src;
  if (id.endsWith("/src/components/CodeBlock.tsx")) return src.replace('import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";', 'import { MeasuredHighlighter as SyntaxHighlighter } from "/scripts/highlight-performance/measured.tsx";');
  if (id.endsWith("/src/components/MarkdownView.tsx")) return src.replace('import ReactMarkdown, { type Components } from "react-markdown";', 'import type { Components } from "react-markdown"; import ReactMarkdown from "/scripts/highlight-performance/markdown.tsx";');
  if (id.endsWith("/src/hooks/useDocumentSearch.ts")) return src.replace(/function buildSearchIndex\(([^)]*)\)([^\{]*)\{/, '$&\n(window as any).__perf.indexBuilds += 1;');
  return src;
} }], build: { outDir: path.join(dir, "dist"), emptyOutDir: true, rollupOptions: { input: path.join(sourceDir, "index.html") } } });
console.log("Built performance app");
const server = http.createServer(async (req, res) => {
  try { const url = new URL(req.url, "http://localhost"); const file = path.join(dir, "dist", url.pathname === "/" ? "scripts/highlight-performance/index.html" : url.pathname);
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html"); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log("Server listening", server.address().port);
const browser = await chromium.launch({ executablePath: process.env.MD_READER_BROWSER || path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"), headless: true, timeout: 15000 });
console.log("Browser started");
try {
 const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
 console.log("Page created");
 const errors = []; page.on("pageerror", e => { errors.push(e.message); console.error(e.message); });
 await page.addInitScript(({content}) => {
  window.__perf = { highlights: [], markdown: [], indexBuilds: 0, longTasks: [] };
  new PerformanceObserver(list => window.__perf.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: "longtask", buffered: true });
  const doc = { path: "D:\\fixtures\\representative.md", name: "representative.md", content, revision: "1" };
  window.__fixture = doc;
  window.__files = { [doc.path]: doc };
  window.__nextPath = doc.path;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let callback = 0;
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => ++callback, unregisterCallback() {}, convertFileSrc: x => x,
   invoke: async (cmd, args) => {
    if (cmd === "get_startup_file") return doc.path;
    if (cmd === "read_markdown_file") return window.__files[args.path];
    if (cmd === "plugin:dialog|open") return window.__nextPath;
    if (cmd === "get_file_revision") return { status: "exists", revision: "1" };
    if (cmd === "load_recovery_draft") return null;
    if (cmd === "plugin:window|inner_size") return {width:1180,height:760};
    if (cmd === "plugin:window|scale_factor") return 1;
    return null;
   } };
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.__copied = text; } } });
  localStorage.setItem("md-reader.settings.v1", JSON.stringify({ theme:"light" }));
 }, {content});
 const started = Date.now();
 console.log("Navigating");
 await page.goto(`http://127.0.0.1:${server.address().port}/`, {waitUntil:"domcontentloaded", timeout:15000});
 console.log("Page loaded");
 await page.locator(".code-block").nth(119).waitFor();
 console.log("Document rendered");
 await page.waitForTimeout(800);
 const snapshot = () => page.evaluate(() => ({...window.__perf, highlights: window.__perf.highlights.length, highlightMs: window.__perf.highlights.reduce((n,x)=>n+x.ms,0), markdownMs: window.__perf.markdown.reduce((n,x)=>n+x,0), markdown: window.__perf.markdown.length, highlightedBlocks:document.querySelectorAll(".code-block .token").length }));
 const opened = await snapshot();
 console.log("Opened",JSON.stringify(opened));
 if (phase === "regression") {
  const { verify } = await import("./regression.mjs");
  await verify({page, content, snapshot, dir});
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
 } else {
 await page.locator(".code-block__copy").first().click(); await page.waitForTimeout(1750);
 const copied = await snapshot();
 console.log("Copy checked");
 for (const fraction of [0.15,0.5,0.9,0.3,0]) { await page.locator(".reader-scroll").evaluate((el,f)=>el.scrollTop=(el.scrollHeight-el.clientHeight)*f,fraction); await page.waitForTimeout(200); }
 const scrolled = await snapshot();
 console.log("Scroll checked");
 await page.getByRole("button",{ name:"Edit",exact:true }).click(); await page.waitForTimeout(600);
 const editOpened = await snapshot();
 console.log("Preview mounted");
 const editor = page.locator(".markdown-editor textarea");
 const inputBurstMs = await editor.evaluate((el,content)=>{
  const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;
  const start=performance.now();
  for(let i=0;i<8;i++){set.call(el,content+`\nedit${i}`);el.dispatchEvent(new Event("input",{bubbles:true}));}
  return performance.now()-start;
 },content);
 await page.waitForTimeout(700);
 const edited = await snapshot();
 const report = { phase, baselineRef: phase === "before" ? baselineRef : undefined, browser:browser.version(), fixture:{ chars:content.length, lines:content.split("\n").length, codeBlocks:120, codeChars:await page.locator(".code-block code").first().evaluate(el=>el.textContent.length) }, opened,copied,scrolled,editOpened,edited,inputBurstMs,errors, elapsedMs:Date.now()-started };
 await writeFile(path.join(dir,`${phase}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 }
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
