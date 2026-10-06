const express = require("express");
const adminAuth = require("../middleware/adminAuth");
const prisma = require("../prisma/prismaClient");

const router = express.Router();

// Template designs are the desktop app's template JSON, stored as-is. The
// server only checks the envelope; the app re-normalizes on install.
const listSelect = {
  id: true,
  name: true,
  description: true,
  category: true,
  language: true,
  pageSize: true,
  orientation: true,
  schemaVersion: true,
  version: true,
  isPublished: true,
  createdAt: true,
  updatedAt: true,
};

// Pulls the indexed columns out of the design so they can't drift from it.
const fromBody = (body = {}) => {
  const config = body.configJson;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { error: "configJson must be a template object" };
  }
  if (!Array.isArray(config.elements)) {
    return { error: "configJson.elements must be an array" };
  }
  const name = String(body.name ?? config.name ?? "").trim();
  if (!name) return { error: "Template name is required" };
  return {
    data: {
      name,
      description: String(body.description ?? config.description ?? ""),
      category: String(body.category ?? config.category ?? "General"),
      language: String(body.language ?? config.language ?? "en"),
      pageSize: String(config.page?.size || "A4"),
      orientation: String(config.page?.orientation || "portrait"),
      schemaVersion: Number(config.schemaVersion) || 1,
      configJson: config,
    },
  };
};

router.get("/", adminAuth, async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      select: listSelect,
      orderBy: { updatedAt: "desc" },
    });
    res.json(templates);
  } catch (error) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ error: "Could not fetch templates" });
  }
});

router.get("/:id", adminAuth, async (req, res) => {
  try {
    const template = await prisma.template.findUnique({
      where: { id: parseInt(req.params.id) },
    });
    if (!template) return res.status(404).json({ error: "Template not found" });
    res.json(template);
  } catch (error) {
    console.error("Error fetching template:", error);
    res.status(500).json({ error: "Could not fetch template" });
  }
});

router.post("/", adminAuth, async (req, res) => {
  const { data, error } = fromBody(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const template = await prisma.template.create({ data });
    res.json(template);
  } catch (err) {
    console.error("Error creating template:", err);
    res.status(500).json({ error: "Could not create template" });
  }
});

router.put("/:id", adminAuth, async (req, res) => {
  const { data, error } = fromBody(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const template = await prisma.template.update({
      where: { id: parseInt(req.params.id) },
      data: { ...data, version: { increment: 1 } },
    });
    res.json(template);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    console.error("Error updating template:", err);
    res.status(500).json({ error: "Could not update template" });
  }
});

router.patch("/:id/publish", adminAuth, async (req, res) => {
  try {
    const template = await prisma.template.update({
      where: { id: parseInt(req.params.id) },
      data: { isPublished: !!req.body.isPublished },
      select: listSelect,
    });
    res.json(template);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    console.error("Error publishing template:", err);
    res.status(500).json({ error: "Could not update template" });
  }
});

router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await prisma.template.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Template not found" });
    console.error("Error deleting template:", err);
    res.status(500).json({ error: "Could not delete template" });
  }
});

module.exports = router;
