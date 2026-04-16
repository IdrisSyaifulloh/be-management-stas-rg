const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const {
  getDraftReportTypes,
  saveDraftReportTypes
} = require("../../utils/draftReportTypes");

const router = express.Router();

function buildDraftReportTypeId() {
  return `DRT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "true";
    const items = await getDraftReportTypes({ activeOnly: !includeInactive });
    res.json(items);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menambah jenis laporan." });
    }

    const { id, label, is_active = true, sort_order } = req.body || {};
    if (!String(label || "").trim()) {
      return res.status(400).json({ message: "label wajib diisi." });
    }

    const currentItems = await getDraftReportTypes({ activeOnly: false });
    const normalizedLabel = String(label).trim();
    const duplicate = currentItems.find(
      (item) => item.label.toLowerCase() === normalizedLabel.toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({ message: "Jenis laporan sudah ada." });
    }

    const nextSortOrder =
      Number.isFinite(Number(sort_order))
        ? Number(sort_order)
        : (currentItems.reduce((maxValue, item) => Math.max(maxValue, item.sort_order || 0), 0) + 1);

    const nextItem = {
      id: id || buildDraftReportTypeId(),
      label: normalizedLabel,
      is_active: is_active !== false,
      sort_order: nextSortOrder
    };

    const savedItems = await saveDraftReportTypes([...currentItems, nextItem]);
    const createdItem = savedItems.find((item) => item.id === nextItem.id) || nextItem;

    res.status(201).json({
      message: "Jenis laporan berhasil ditambahkan.",
      data: createdItem
    });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus jenis laporan." });
    }

    const currentItems = await getDraftReportTypes({ activeOnly: false });
    const nextItems = currentItems.filter((item) => item.id !== req.params.id);

    if (nextItems.length === currentItems.length) {
      return res.status(404).json({ message: "Jenis laporan tidak ditemukan." });
    }

    await saveDraftReportTypes(nextItems);
    res.json({ message: "Jenis laporan berhasil dihapus." });
  })
);

module.exports = router;
