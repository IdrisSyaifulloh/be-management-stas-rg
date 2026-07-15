const { spawnSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const {
  renderCompletionLetterPdf,
  buildLetterData
} = require("../utils/documentCenterCompletionLetterTemplates");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".tmp-completion-letter-preview");
const TEMPLATE_PATH = path.join(ROOT, "resources", "document-center", "templates", "completion-letter-completed-internship.pdf");
const WATCH_FILE = path.join(ROOT, "utils", "documentCenterCompletionLetterTemplates.js");

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!item) return fallback;
  if (item === name) return true;
  return item.slice(prefix.length);
}

function runOnceInFreshProcess() {
  const result = spawnSync(process.execPath, [__filename, "--once"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  return result.status || 0;
}

async function renderPng(pdfPath, pngPath) {
  const gs = "C:\\Program Files\\gs\\gs10.07.1\\bin\\gswin64c.exe";
  const args = [
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-sDEVICE=png16m",
    "-r144",
    "-dFirstPage=1",
    "-dLastPage=1",
    `-sOutputFile=${pngPath}`,
    pdfPath
  ];
  const result = spawnSync(gs, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Gagal render PNG dengan Ghostscript.").trim());
  }
}

async function renderOnce() {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const pdfPath = path.join(OUT_DIR, "completion-letter-filled.pdf");
  const pngPath = path.join(OUT_DIR, "completion-letter-filled.png");
  const htmlPath = path.join(OUT_DIR, "preview.html");
  const backgroundBytes = await fsp.readFile(TEMPLATE_PATH);
  const data = buildLetterData({
    studentSnapshot: {
      name: "Test A",
      nim: "607032300048",
      prodi: "D3 Sistem Informasi Akuntansi"
    },
    periodSnapshot: {
      startDate: "2026-05-01",
      endDate: "2026-08-15"
    },
    projectSnapshot: {
      title: "Riset Alumni STAS-RG Dev Fixture",
      role: null
    }
  });
  const buffer = await renderCompletionLetterPdf({
    backgroundBytes,
    data,
    documentNumber: "09.001/STASRG/VII/2026",
    issuedAt: "2026-07-15T00:00:00Z"
  });
  await fsp.writeFile(pdfPath, buffer);
  await renderPng(pdfPath, pngPath);
  await fsp.writeFile(htmlPath, `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <title>Document Center SKS Preview</title>
  <style>
    body { margin: 0; background: #222; color: #fff; font-family: Arial, sans-serif; }
    header { padding: 10px 14px; font-size: 13px; }
    img { display: block; max-width: 100vw; height: auto; margin: 0 auto; background: #fff; }
  </style>
</head>
<body>
  <header>Auto-refresh preview: Surat Keterangan Selesai Magang</header>
  <img id="preview" src="./completion-letter-filled.png" alt="completion letter preview" />
  <script>
    setInterval(() => {
      document.getElementById("preview").src = "./completion-letter-filled.png?t=" + Date.now();
    }, 1000);
  </script>
</body>
</html>
`);
  console.log(JSON.stringify({
    ok: true,
    pdf: pdfPath,
    png: pngPath,
    html: htmlPath,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

async function main() {
  const once = Boolean(argValue("--once", false));
  const watch = Boolean(argValue("--watch", false));

  if (once || !watch) {
    await renderOnce();
    return;
  }

  console.log("Watching SKS layout.");
  console.log(`Output folder: ${OUT_DIR}`);
  console.log("Edit utils/documentCenterCompletionLetterTemplates.js, then save.");

  let timer = null;
  const render = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const code = runOnceInFreshProcess();
      if (code !== 0) console.error(`Preview render failed with exit code ${code}.`);
    }, 250);
  };

  render();
  fs.watchFile(WATCH_FILE, { interval: 500 }, render);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
