-- Registro do aviso de férias enviado manualmente pelo WhatsApp
ALTER TABLE "ferias" ADD COLUMN "avisoWhatsappEm" DATETIME;
ALTER TABLE "ferias" ADD COLUMN "avisoWhatsappPor" TEXT;
