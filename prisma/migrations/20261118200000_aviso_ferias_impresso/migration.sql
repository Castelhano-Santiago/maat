-- Aviso de Férias impresso: dados da empresa, centro de custo do colaborador e registro de assinatura
ALTER TABLE "empresa" ADD COLUMN "cnpj" TEXT;
ALTER TABLE "empresa" ADD COLUMN "cidadeSede" TEXT;
ALTER TABLE "funcionario" ADD COLUMN "centroCusto" TEXT;
ALTER TABLE "ferias" ADD COLUMN "avisoAssinadoEm" DATETIME;
ALTER TABLE "ferias" ADD COLUMN "avisoAssinadoPor" TEXT;
