// Publishes the designs that used to be built into the desktop app (Simple,
// Modern, Gradient, ...) as catalog templates, from the JSON in
// scripts/builtin-templates. Each row is tagged with its old design key
// (legacyKey) so labs that already saved one of them are moved to the
// catalog entry and receive its updates.
//
// Idempotent — an entry that already exists is left alone, so edits made in
// the dashboard are never overwritten. Pass --force to replace the layout of
// existing entries with the file's copy (bumps their version).
//
// Usage:
//   node scripts/seed-builtin-templates.js                  (dry run — no writes)
//   node scripts/seed-builtin-templates.js --apply           (creates missing rows)
//   node scripts/seed-builtin-templates.js --apply --force   (also resets existing ones)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma/prismaClient");

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const DIR = path.join(__dirname, "builtin-templates");

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
  console.log(APPLY ? "APPLY mode" : "DRY RUN (pass --apply to write)", `— ${files.length} designs\n`);

  for (const file of files) {
    const { legacyKey, name, isFree, sortOrder, config } = JSON.parse(
      fs.readFileSync(path.join(DIR, file), "utf8")
    );
    const fields = {
      name,
      description: config.description || "",
      category: config.category || "General",
      language: config.language || "en",
      pageSize: config.page?.size || "A4",
      orientation: config.page?.orientation || "portrait",
      schemaVersion: config.schemaVersion || 1,
      configJson: config,
    };

    const existing = await prisma.template.findUnique({ where: { legacyKey } });
    if (existing && !FORCE) {
      console.log(`skip    ${legacyKey.padEnd(13)} already exists (id ${existing.id})`);
      continue;
    }
    if (!APPLY) {
      console.log(`${existing ? "reset" : "create"}  ${legacyKey.padEnd(13)} ${isFree ? "free" : "paid"}`);
      continue;
    }
    if (existing) {
      await prisma.template.update({
        where: { id: existing.id },
        data: { ...fields, version: { increment: 1 } },
      });
      console.log(`reset   ${legacyKey.padEnd(13)} id ${existing.id}`);
    } else {
      const row = await prisma.template.create({
        data: { ...fields, legacyKey, isFree, sortOrder, isPublished: true },
      });
      console.log(`created ${legacyKey.padEnd(13)} id ${row.id} (${isFree ? "free" : "paid"})`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
