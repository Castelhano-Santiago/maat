-- Cadastro da pensão alimentícia por colaborador (modalidade da decisão judicial)
CREATE TABLE "pensao_alimenticia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "empresaId" TEXT NOT NULL,
    "matricula" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "modalidade" TEXT NOT NULL,
    "percentual" DECIMAL,
    "valorFixo" DECIMAL,
    "incide13" BOOLEAN NOT NULL DEFAULT true,
    "incideFerias" BOOLEAN NOT NULL DEFAULT true,
    "observacao" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pensao_alimenticia_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "empresa" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pensao_alimenticia_empresaId_matricula_key" ON "pensao_alimenticia"("empresaId", "matricula");
