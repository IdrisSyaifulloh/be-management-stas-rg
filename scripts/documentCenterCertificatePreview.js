const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");

const express = require("../node_modules/express");
const router = require("../routes/api/documentCenter");
const { pool } = require("../db/pool");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".tmp-certificate-preview");
const TEMPLATE_KEYS = new Set(["certificate_completed_internship", "certificate_completed_research"]);

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!item) return fallback;
  if (item === name) return true;
  return item.slice(prefix.length);
}

function normalizeTemplate(value) {
  const raw = String(value || "riset").toLowerCase();
  if (raw === "magang" || raw === "internship") return "certificate_completed_internship";
  if (raw === "riset" || raw === "research") return "certificate_completed_research";
  if (TEMPLATE_KEYS.has(raw)) return raw;
  throw new Error("Template harus magang/riset/certificate_completed_internship/certificate_completed_research.");
}

function runOnceInFreshProcess(templateKey) {
  const result = spawnSync(process.execPath, [__filename, "--once", `--template=${templateKey}`], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  return result.status || 0;
}

async function renderPng(pdfPath, pngPath) {
  const python = `
import sys
from pathlib import Path
import pypdfium2 as pdfium
pdf_path = Path(sys.argv[1])
png_path = Path(sys.argv[2])
pdf = pdfium.PdfDocument(str(pdf_path))
page = pdf[0]
bitmap = page.render(scale=1.5)
bitmap.to_pil().save(png_path)
`;
  const scriptPath = path.join(OUT_DIR, "_render_pdfium.py");
  await fsp.writeFile(scriptPath, python);
  const result = spawnSync("python", [scriptPath, pdfPath, pngPath], { cwd: ROOT, encoding: "utf8" });
  await fsp.rm(scriptPath, { force: true });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Gagal render PNG. Pastikan python + pypdfium2 tersedia.").trim());
  }
}

async function fetchPreview(templateKey) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.authUser = { id: "OP001", role: "operator" };
    next();
  });
  app.use("/api/document-center", router);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ message: err.message || "Preview gagal." });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const templateResult = await pool.query(
      "SELECT id FROM dc_document_templates WHERE template_key = $1 LIMIT 1",
      [templateKey]
    );
    const templateId = templateResult.rows[0]?.id;
    if (!templateId) throw new Error(`Template ${templateKey} belum ada di dc_document_templates.`);

    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/document-center/operator/templates/${encodeURIComponent(templateId)}/preview`);
    if (!response.ok) {
      throw new Error(`Preview HTTP ${response.status}: ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function renderOnce(templateKey) {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const pdfPath = path.join(OUT_DIR, `${templateKey}.pdf`);
  const pngPath = path.join(OUT_DIR, `${templateKey}.png`);
  const htmlPath = path.join(OUT_DIR, "preview.html");
  const buffer = await fetchPreview(templateKey);
  await fsp.writeFile(pdfPath, buffer);
  await renderPng(pdfPath, pngPath);
  await fsp.writeFile(htmlPath, `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>Document Center Certificate Preview</title>
  <style>
    body { margin: 0; background: #222; color: #fff; font-family: Arial, sans-serif; }
    header { padding: 10px 14px; font-size: 13px; }
    img { display: block; max-width: 100vw; height: auto; margin: 0 auto; }
  </style>
</head>
<body>
  <header>Auto-refresh preview: ${templateKey}</header>
  <img id="preview" src="./${templateKey}.png" alt="certificate preview" />
  <script>
    setInterval(() => {
      document.getElementById("preview").src = "./${templateKey}.png?t=" + Date.now();
    }, 1000);
  </script>
</body>
</html>
`);
  await pool.end();
  console.log(JSON.stringify({
    ok: true,
    template: templateKey,
    pdf: pdfPath,
    png: pngPath,
    html: htmlPath,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

async function main() {
  const templateKey = normalizeTemplate(argValue("--template", "riset"));
  const once = Boolean(argValue("--once", false));
  const watch = Boolean(argValue("--watch", false));

  if (once || !watch) {
    await renderOnce(templateKey);
    return;
  }

  console.log(`Watching certificate layout for ${templateKey}.`);
  console.log(`Output folder: ${OUT_DIR}`);
  console.log("Edit utils/documentCenterCertificateTemplates.js, then save.");

  let timer = null;
  const render = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const code = runOnceInFreshProcess(templateKey);
      if (code !== 0) console.error(`Preview render failed with exit code ${code}.`);
    }, 250);
  };

  render();
  fs.watchFile(path.join(ROOT, "utils", "documentCenterCertificateTemplates.js"), { interval: 500 }, render);
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
