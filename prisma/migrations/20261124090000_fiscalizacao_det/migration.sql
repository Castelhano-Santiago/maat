-- Fiscalizações em andamento no DET, com lembrete por e-mail até o OK do dia
CREATE TABLE "fiscalizacao_processo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "numero" TEXT NOT NULL,
    "assunto" TEXT NOT NULL,
    "encerrado" BOOLEAN NOT NULL DEFAULT false,
    "encerradoEm" DATETIME,
    "ultimoOkEm" DATETIME,
    "ultimoOkPorNome" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "fiscalizacao_conferencia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "processoId" TEXT NOT NULL,
    "usuarioNome" TEXT NOT NULL,
    "observacao" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fiscalizacao_conferencia_processoId_fkey" FOREIGN KEY ("processoId") REFERENCES "fiscalizacao_processo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "fiscalizacao_conferencia_processoId_idx" ON "fiscalizacao_conferencia"("processoId");

CREATE TABLE "fiscalizacao_alerta_envio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "horario" TEXT NOT NULL,
    "sucesso" BOOLEAN NOT NULL,
    "processos" INTEGER NOT NULL,
    "erro" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "fiscalizacao_alerta_envio_horario_idx" ON "fiscalizacao_alerta_envio"("horario");

CREATE TABLE "fiscalizacao_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email1" TEXT,
    "email2" TEXT,
    "updatedAt" DATETIME NOT NULL
);
