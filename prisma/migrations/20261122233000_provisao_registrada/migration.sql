-- Provisão da folha enviada ao financeiro (cópia dos valores no momento do envio)
CREATE TABLE "provisao_registrada" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "empresaId" TEXT NOT NULL,
    "competencia" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valores" TEXT NOT NULL,
    "registradoPorId" TEXT NOT NULL,
    "registradoPorNome" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "provisao_registrada_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresa" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "provisao_registrada_empresaId_competencia_tipo_key" ON "provisao_registrada"("empresaId", "competencia", "tipo");
