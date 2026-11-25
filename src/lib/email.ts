// Envio de e-mail pela conta da empresa. Os dados de acesso ficam no arquivo .env (não no banco):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e, opcional, SMTP_FROM (remetente exibido).
// Porta 465 usa conexão segura direta; 587 (padrão) usa STARTTLS.

import nodemailer from "nodemailer";

export function emailConfigurado(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function enviarEmail(msg: { para: string[]; assunto: string; texto: string; html: string }) {
  if (!emailConfigurado()) {
    throw new Error("Conta de e-mail de envio não configurada (SMTP_HOST, SMTP_USER e SMTP_PASS no .env).");
  }
  const porta = Number(process.env.SMTP_PORT || 587);
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: porta,
    secure: porta === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporte.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: msg.para.join(", "),
    subject: msg.assunto,
    text: msg.texto,
    html: msg.html,
  });
}
