const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv; charset=utf-8";
const PDF_MIME = "application/pdf";

function normalizeCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function csvEscape(value) {
  const str = normalizeCell(value);
  return str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function buildCsvBuffer(headers, rows, headerRows = null) {
  const normalizedHeaderRows = Array.isArray(headerRows) && headerRows.length ? headerRows : [headers];
  const csvRows = rows.map((row) => row.map((cell) => csvEscape(cell)).join(","));
  const csvHeaders = normalizedHeaderRows.map((row) => row.map((cell) => csvEscape(cell)).join(","));
  const csvContent = [...csvHeaders, ...csvRows].join("\n");
  return Buffer.from(`\ufeff${csvContent}`, "utf8");
}

function xmlEscape(value) {
  return normalizeCell(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(index) {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function getDisplayWidth(value) {
  return normalizeCell(value).replace(/\r?\n/g, " ").length;
}

function computeColumnWidths(headers, rows, headerRows, maxColumns) {
  const dataRows = [...headerRows, ...rows];

  return Array.from({ length: maxColumns }, (_, columnIndex) => {
    const maxLength = Math.max(
      getDisplayWidth(headers[columnIndex]),
      ...dataRows.map((row) => getDisplayWidth(row[columnIndex]))
    );

    if (columnIndex === 0) {
      return Math.max(18, Math.min(42, maxLength + 2));
    }

    return Math.max(9, Math.min(18, maxLength + 2));
  });
}

function buildSheetXml(headers, rows, headerRows = null, merges = []) {
  const normalizedHeaderRows = Array.isArray(headerRows) && headerRows.length ? headerRows : [headers];
  const dataRows = [...normalizedHeaderRows, ...rows];
  const maxColumns = Math.max(
    headers.length,
    ...normalizedHeaderRows.map((row) => row.length),
    ...rows.map((row) => row.length),
    1
  );
  const lastColumn = columnLetter(maxColumns - 1);
  const lastRow = Math.max(dataRows.length, 1);
  const columnWidths = computeColumnWidths(headers, rows, normalizedHeaderRows, maxColumns);
  const colsXml = `<cols>${columnWidths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join("")}</cols>`;

  const rowXml = dataRows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          const ref = `${columnLetter(cellIndex)}${rowIndex + 1}`;
          if (typeof cell === "number" && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const mergeXml = Array.isArray(merges) && merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${xmlEscape(ref)}"/>`).join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${colsXml}
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
</worksheet>`;
}

function buildXlsxFiles({ sheetName, headers, rows, title, headerRows = null, merges = [] }) {
  const safeSheetName = xmlEscape((sheetName || "Sheet1").slice(0, 31) || "Sheet1");
  const safeTitle = xmlEscape(title || sheetName || "Export");
  const createdAt = new Date().toISOString();

  return [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`, "utf8")
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`, "utf8")
    },
    {
      name: "docProps/app.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>STAS-RG Export</Application>
  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${safeSheetName}</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>`, "utf8")
    },
    {
      name: "docProps/core.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${safeTitle}</dc:title>
  <dc:creator>STAS-RG Backend</dc:creator>
  <cp:lastModifiedBy>STAS-RG Backend</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>
</cp:coreProperties>`, "utf8")
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`, "utf8")
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, "utf8")
    },
    {
      name: "xl/styles.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1">
    <font>
      <sz val="11"/>
      <name val="Calibri"/>
    </font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`, "utf8")
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(buildSheetXml(headers, rows, headerRows, merges), "utf8")
    }
  ];
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let current = i;
    for (let j = 0; j < 8; j += 1) {
      current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
    }
    table[i] = current >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | Math.floor(date.getSeconds() / 2);
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0xf) << 5)
    | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = getDosDateTime();

  files.forEach((file) => {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const dataBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const checksum = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(now.dosTime, 10);
    localHeader.writeUInt16LE(now.dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);

    localParts.push(localHeader, dataBuffer);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(now.dosTime, 12);
    centralHeader.writeUInt16LE(now.dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuffer.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuffer.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = offset;
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function buildXlsxBuffer({ title, headers, rows, sheetName, headerRows = null, merges = [] }) {
  return createZipBuffer(buildXlsxFiles({ title, headers, rows, sheetName, headerRows, merges }));
}

function toPdfLiteralString(value) {
  return `(${normalizeCell(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")})`;
}

function stripLineBreaks(value) {
  return normalizeCell(value).replace(/\s+/g, " ").trim();
}

// Wrap text into lines that fit within cellWidth at the given fontSize.
// Returns an array of line strings — never empty, always at least ["""].
function wrapText(value, cellWidth, fontSize) {
  const approxCharWidth = fontSize * 0.52;
  const maxChars = Math.max(4, Math.floor(cellWidth / approxCharWidth));
  const text = normalizeCell(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

  if (!text) return [""];
  if (text.length <= maxChars) return [text];

  const words = text.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    // Split ultra-long words that exceed the full column width
    let remaining = word;
    while (remaining.length > maxChars) {
      if (current) { lines.push(current); current = ""; }
      lines.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    if (!remaining) continue;

    const candidate = current ? `${current} ${remaining}` : remaining;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = remaining;
    }
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// Compute the pixel height required for a data row given its wrapped lines.
function computeWrappedRowHeight(row, columnWidths, cellPadding, rowFontSize, lineHeight, minHeight) {
  let maxLines = 1;
  row.forEach((cell, index) => {
    const innerWidth = Math.max(8, (columnWidths[index] || 50) - cellPadding * 2);
    maxLines = Math.max(maxLines, wrapText(cell, innerWidth, rowFontSize).length);
  });
  return Math.max(minHeight, maxLines * lineHeight + cellPadding * 2);
}

function computePdfColumnWidths(headers, rows, totalWidth, columnWeights = []) {
  if (columnWeights.length === headers.length) {
    const weightSum = columnWeights.reduce((sum, weight) => sum + Math.max(0, Number(weight) || 0), 0) || headers.length;
    return columnWeights.map((weight) => (totalWidth * (Math.max(0, Number(weight) || 0) || 1)) / weightSum);
  }

  const weights = headers.map((header, index) => {
    const sampleMax = rows.slice(0, 40).reduce((max, row) => {
      return Math.max(max, stripLineBreaks(row[index]).length);
    }, stripLineBreaks(header).length);
    return Math.max(sampleMax, 8);
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || headers.length;
  return weights.map((weight) => (totalWidth * weight) / totalWeight);
}

function buildPdfTextCommand({ text, x, y, font = "F1", fontSize = 10 }) {
  return `BT /${font} ${fontSize} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${toPdfLiteralString(text)} Tj ET`;
}

function buildPdfRectCommand(x, y, width, height, strokeWidth = 0.6) {
  return `${strokeWidth} w ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`;
}

function buildPdfFillRectCommand(x, y, width, height, grayValue = 0.94) {
  return `q ${grayValue} g ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f Q`;
}

function buildPdfTablePage({
  title,
  generatedAt,
  metadata,
  headers,
  headerRows,
  rows,
  rowHeights,
  pageIndex,
  pageWidth,
  pageHeight,
  margins,
  columnWidths,
  rowFontSize,
  cellPadding,
  lineHeight
}) {
  const commands = [];
  const titleFontSize = 16;
  const textFontSize = 10;
  const normalizedHeaderRows = Array.isArray(headerRows) && headerRows.length ? headerRows : [headers];
  const headerRowHeight = Math.max(14, rowFontSize + cellPadding * 2 + 2);
  const headerHeight = headerRowHeight * normalizedHeaderRows.length;
  const usableWidth = pageWidth - margins.left - margins.right;

  let cursorY = pageHeight - margins.top;

  commands.push(buildPdfTextCommand({
    text: pageIndex === 0 ? `Export ${title}` : `Export ${title} (lanjutan)`,
    x: margins.left,
    y: cursorY,
    font: "F2",
    fontSize: titleFontSize
  }));
  cursorY -= 22;

  commands.push(buildPdfTextCommand({
    text: `Dibuat: ${generatedAt}`,
    x: margins.left,
    y: cursorY,
    font: "F1",
    fontSize: textFontSize
  }));
  cursorY -= 16;

  metadata.forEach((item) => {
    commands.push(buildPdfTextCommand({
      text: item,
      x: margins.left,
      y: cursorY,
      font: "F1",
      fontSize: textFontSize
    }));
    cursorY -= 14;
  });

  cursorY -= 8;

  const headerTopY = cursorY;
  const headerBottomY = headerTopY - headerHeight;
  commands.push(buildPdfFillRectCommand(margins.left, headerBottomY, usableWidth, headerHeight));
  commands.push(buildPdfRectCommand(margins.left, headerBottomY, usableWidth, headerHeight));

  normalizedHeaderRows.forEach((headerRow, headerRowIndex) => {
    const rowTopY = headerTopY - headerRowIndex * headerRowHeight;
    const rowBottomY = rowTopY - headerRowHeight;
    if (headerRowIndex > 0) {
      commands.push(`${margins.left.toFixed(2)} ${rowTopY.toFixed(2)} m ${(margins.left + usableWidth).toFixed(2)} ${rowTopY.toFixed(2)} l S`);
    }

    let currentX = margins.left;
    headers.forEach((header, index) => {
      const width = columnWidths[index];
      if (index > 0) {
        commands.push(`${currentX.toFixed(2)} ${rowBottomY.toFixed(2)} m ${currentX.toFixed(2)} ${rowTopY.toFixed(2)} l S`);
      }
      const headerLines = normalizeCell(headerRow[index] ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      (headerLines.length ? headerLines : [""]).slice(0, 2).forEach((line, lineIdx) => {
        commands.push(buildPdfTextCommand({
          text: stripLineBreaks(line),
          x: currentX + cellPadding,
          y: rowTopY - cellPadding - (rowFontSize - 1) - lineIdx * lineHeight,
          font: "F2",
          fontSize: rowFontSize
        }));
      });
      currentX += width;
    });
  });

  let rowTopY = headerBottomY;
  rows.forEach((row, rowIdx) => {
    const rowH = (rowHeights && rowHeights[rowIdx]) ? rowHeights[rowIdx] : 20;
    const rowBottomY = rowTopY - rowH;
    commands.push(buildPdfRectCommand(margins.left, rowBottomY, usableWidth, rowH, 0.4));

    let cellX = margins.left;
    row.forEach((cell, index) => {
      const width = columnWidths[index];
      if (index > 0) {
        commands.push(`${cellX.toFixed(2)} ${rowBottomY.toFixed(2)} m ${cellX.toFixed(2)} ${rowTopY.toFixed(2)} l S`);
      }

      // Render wrapped lines top-to-bottom within the cell
      const innerWidth = Math.max(8, width - cellPadding * 2);
      const lines = wrapText(cell, innerWidth, rowFontSize);
      lines.forEach((line, lineIdx) => {
        const textY = rowTopY - cellPadding - (rowFontSize - 1) - lineIdx * lineHeight;
        if (textY >= rowBottomY + 1) {
          commands.push(buildPdfTextCommand({
            text: line,
            x: cellX + cellPadding,
            y: textY,
            font: "F1",
            fontSize: rowFontSize
          }));
        }
      });

      cellX += width;
    });

    rowTopY = rowBottomY;
  });

  return commands.join("\n");
}

function getPdfTableConfig({ headers, rows, columnWeights = [], headerRows = null, metadata = [], filtersSummary = [] }) {
  const pageWidth = 842;
  const pageHeight = 595;
  const columnCount = Math.max(headers.length, 1);
  const denseTable = columnCount > 14;
  const margins = denseTable
    ? { top: 28, right: 18, bottom: 24, left: 18 }
    : { top: 36, right: 36, bottom: 30, left: 36 };

  const ROW_FONT_SIZE = Math.max(5, Math.min(9, Math.floor(120 / columnCount)));
  const CELL_PADDING = Math.max(1.5, Math.min(4, ROW_FONT_SIZE * 0.38));
  const LINE_HEIGHT = Math.max(6, ROW_FONT_SIZE + 2);
  const MIN_ROW_HEIGHT = Math.max(12, ROW_FONT_SIZE + CELL_PADDING * 2 + 2);

  const generatedAt = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const headerMetadata = metadata.length ? metadata : filtersSummary;
  const normalizedHeaderRows = Array.isArray(headerRows) && headerRows.length ? headerRows : [headers];
  const usableWidth = pageWidth - margins.left - margins.right;
  const columnWidths = computePdfColumnWidths(headers, rows, usableWidth, columnWeights);

  // Pre-compute each row's pixel height based on wrapped content
  const allRowHeights = rows.map((row) =>
    computeWrappedRowHeight(row, columnWidths, CELL_PADDING, ROW_FONT_SIZE, LINE_HEIGHT, MIN_ROW_HEIGHT)
  );

  // Height budget per page: title block + metadata lines + table header
  const titleBlockH = 22 + 16 + 8;
  const metaH = headerMetadata.length * 14;
  const tableHeaderH = Math.max(14, ROW_FONT_SIZE + CELL_PADDING * 2 + 2) * normalizedHeaderRows.length;
  const availableBodyH = pageHeight - margins.top - margins.bottom - titleBlockH - metaH - tableHeaderH;

  return {
    pageWidth,
    pageHeight,
    margins,
    rowFontSize: ROW_FONT_SIZE,
    cellPadding: CELL_PADDING,
    lineHeight: LINE_HEIGHT,
    columnWidths,
    rowHeights: allRowHeights,
    headerMetadata,
    normalizedHeaderRows,
    availableBodyH
  };
}

function paginateRows(rows, rowHeights, availableBodyH) {
  const pageChunks = [];
  const pageChunkHeights = [];

  if (rows.length === 0) {
    pageChunks.push([]);
    pageChunkHeights.push([]);
  } else {
    let offset = 0;
    while (offset < rows.length) {
      let accumulated = 0;
      let count = 0;
      while (offset + count < rows.length) {
        const h = rowHeights[offset + count];
        if (count > 0 && accumulated + h > availableBodyH) break;
        accumulated += h;
        count++;
      }
      count = Math.max(1, count);
      pageChunks.push(rows.slice(offset, offset + count));
      pageChunkHeights.push(rowHeights.slice(offset, offset + count));
      offset += count;
    }
  }

  return { pageChunks, pageChunkHeights };
}

function buildPdfBuffer({ title, headers, rows, filtersSummary = [], metadata = [], columnWeights = [], headerRows = null, sections = null }) {
  const generatedAt = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const pdfSections = Array.isArray(sections) && sections.length
    ? sections
    : [{
      title,
      headers,
      rows,
      metadata,
      filtersSummary,
      columnWeights,
      headerRows
    }];

  const pagePlans = [];
  pdfSections.forEach((section) => {
    const sectionHeaders = section.headers || headers;
    const sectionRows = section.rows || [];
    const config = getPdfTableConfig({
      headers: sectionHeaders,
      rows: sectionRows,
      columnWeights: section.columnWeights || columnWeights,
      headerRows: section.headerRows || headerRows,
      metadata: section.metadata || metadata,
      filtersSummary: section.filtersSummary || filtersSummary
    });
    const { pageChunks, pageChunkHeights } = paginateRows(sectionRows, config.rowHeights, config.availableBodyH);

    pageChunks.forEach((chunk, sectionPageIndex) => {
      pagePlans.push({
        title: section.title || title,
        headers: sectionHeaders,
        rows: chunk,
        rowHeights: pageChunkHeights[sectionPageIndex],
        pageIndex: sectionPageIndex,
        config
      });
    });
  });

  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  const pageObjectNumbers = [];
  const contentObjectNumbers = [];
  let nextObjectNumber = 5;

  pagePlans.forEach(() => {
    pageObjectNumbers.push(nextObjectNumber);
    contentObjectNumbers.push(nextObjectNumber + 1);
    nextObjectNumber += 2;
  });

  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((num) => `${num} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  pagePlans.forEach((plan, index) => {
    const pageObjectNumber = pageObjectNumbers[index];
    const contentObjectNumber = contentObjectNumbers[index];
    const { config } = plan;
    const stream = buildPdfTablePage({
      title: plan.title,
      generatedAt,
      metadata: config.headerMetadata,
      headers: plan.headers,
      headerRows: config.normalizedHeaderRows,
      rows: plan.rows,
      rowHeights: plan.rowHeights,
      pageIndex: plan.pageIndex,
      pageWidth: config.pageWidth,
      pageHeight: config.pageHeight,
      margins: config.margins,
      columnWidths: config.columnWidths,
      rowFontSize: config.rowFontSize,
      cellPadding: config.cellPadding,
      lineHeight: config.lineHeight
    });
    const contentBuffer = Buffer.from(stream, "utf8");

    objects[pageObjectNumber - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${config.pageWidth} ${config.pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`;
    objects[contentObjectNumber - 1] = `<< /Length ${contentBuffer.length} >>\nstream\n${stream}\nendstream`;
  });

  const pdfParts = ["%PDF-1.4\n"];
  const offsets = [0];

  objects.forEach((objectBody, index) => {
    offsets.push(Buffer.byteLength(pdfParts.join(""), "utf8"));
    pdfParts.push(`${index + 1} 0 obj\n${objectBody}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(pdfParts.join(""), "utf8");
  const xrefEntries = [`0000000000 65535 f `];
  for (let i = 1; i < offsets.length; i += 1) {
    xrefEntries.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
  }

  pdfParts.push(`xref\n0 ${objects.length + 1}\n${xrefEntries.join("\n")}\n`);
  pdfParts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(pdfParts.join(""), "utf8");
}

module.exports = {
  buildCsvBuffer,
  buildPdfBuffer,
  buildXlsxBuffer,
  CSV_MIME,
  PDF_MIME,
  XLSX_MIME
};
