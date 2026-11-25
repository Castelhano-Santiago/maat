-- Mais de uma pensão por colaborador: tira a unicidade (empresa, matrícula) e guarda o beneficiário
DROP INDEX "pensao_alimenticia_empresaId_matricula_key";
ALTER TABLE "pensao_alimenticia" ADD COLUMN "beneficiario" TEXT;
CREATE INDEX "pensao_alimenticia_empresaId_matricula_idx" ON "pensao_alimenticia"("empresaId", "matricula");
