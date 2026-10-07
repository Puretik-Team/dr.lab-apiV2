-- AlterTable
ALTER TABLE "Template" ADD COLUMN "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "legacyKey" TEXT,
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "Template_legacyKey_key" ON "Template"("legacyKey");
