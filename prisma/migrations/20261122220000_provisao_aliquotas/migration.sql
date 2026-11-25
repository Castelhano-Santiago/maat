-- Alíquotas do INSS da empresa para a provisão da folha
ALTER TABLE "empresa" ADD COLUMN "provisaoPatronal" DECIMAL;
ALTER TABLE "empresa" ADD COLUMN "provisaoCprbReceita" DECIMAL;
ALTER TABLE "empresa" ADD COLUMN "provisaoTerceiros" DECIMAL;
ALTER TABLE "empresa" ADD COLUMN "provisaoRat" DECIMAL;
-- Valores informados pelo DP em 22/11/2026 (RAT ainda a informar)
UPDATE "empresa" SET "provisaoPatronal" = 20, "provisaoCprbReceita" = 0, "provisaoTerceiros" = 5.8 WHERE "nome" LIKE 'PANTANAL%' OR "nome" LIKE 'LOGTRANS%';
UPDATE "empresa" SET "provisaoPatronal" = 10, "provisaoCprbReceita" = 1.2, "provisaoTerceiros" = 5.8 WHERE "nome" LIKE 'RAPIDO%' OR "nome" LIKE 'VPAR%';
