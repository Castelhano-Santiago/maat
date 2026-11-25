// Envio do lembrete por e-mail das fiscalizações pendentes (usado pelo agendador e pelo botão de teste).

import { prisma } from "@/lib/prisma";
import { enviarEmail, emailConfigurado } from "@/lib/email";
import { chaveHorario, horarioAtual, pendenteHoje } from "@/lib/fiscalizacao";

const CONFIG_ID = "padrao";
// Se o envio falhar (internet fora, senha errada), tenta de novo depois deste intervalo.
const ESPERA_APOS_FALHA_MS = 15 * 60_000;

export async function lerConfig() {
  const c = await prisma.fiscalizacaoConfig.findUnique({ where: { id: CONFIG_ID } });
  return { email1: c?.email1 ?? "", email2: c?.email2 ?? "" };
}

export async function salvarConfig(email1: string, email2: string) {
  await prisma.fiscalizacaoConfig.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, email1: email1 || null, email2: email2 || null },
    update: { email1: email1 || null, email2: email2 || null },
  });
}

async function destinatarios(): Promise<string[]> {
  const c = await lerConfig();
  return [c.email1, c.email2].map((e) => e.trim()).filter(Boolean);
}

function escapar(t: string) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dataHora(d: Date) {
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type ProcessoAlerta = { numero: string; assunto: string; ultimoOkEm: Date | null; ultimoOkPorNome: string | null };

function montarMensagem(processos: ProcessoAlerta[], teste: boolean) {
  const link = `${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/admin/fiscalizacao`;
  const qtd = processos.length;
  const assunto = `${teste ? "[TESTE] " : ""}DET: ${qtd} fiscalização(ões) aguardando conferência`;
  const ultimo = (p: ProcessoAlerta) =>
    p.ultimoOkEm ? `último OK em ${dataHora(p.ultimoOkEm)} por ${p.ultimoOkPorNome ?? "-"}` : "ainda sem OK";

  const texto = [
    teste ? "Este é um e-mail de TESTE do lembrete de fiscalizações.\n" : "",
    `Há ${qtd} processo(s) de fiscalização no DET aguardando conferência:`,
    "",
    ...processos.map((p) => `• ${p.numero} — ${p.assunto} (${ultimo(p)})`),
    "",
    "Entre no DET, confira o andamento de cada processo e dê o OK no sistema Maat (Fiscalização DET).",
    "Este lembrete sai às segundas e quintas, às 08h, 11h, 14h e 17h, até todos receberem o OK.",
    "",
    `Sistema: ${link}`,
  ].join("\n");

  const linhas = processos
    .map(
      (p) =>
        `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace">${escapar(p.numero)}</td>` +
        `<td style="padding:6px 10px;border:1px solid #ddd">${escapar(p.assunto)}</td>` +
        `<td style="padding:6px 10px;border:1px solid #ddd;color:#666">${escapar(ultimo(p))}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
${teste ? '<p style="color:#b45309"><b>Este é um e-mail de TESTE do lembrete de fiscalizações.</b></p>' : ""}
<p>Há <b>${qtd}</b> processo(s) de fiscalização no <b>DET</b> aguardando conferência:</p>
<table style="border-collapse:collapse">
<tr><th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Número</th><th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Assunto</th><th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Situação</th></tr>
${linhas}
</table>
<p>Entre no DET, confira o andamento de cada processo e dê o <b>OK</b> no sistema Maat (Fiscalização DET).</p>
<p style="color:#666;font-size:12px">Este lembrete sai às segundas e quintas, às 08h, 11h, 14h e 17h, até todos receberem o OK.<br>
Sistema (abre no computador do DP): <a href="${link}">${link}</a></p>
</div>`;
  return { assunto, texto, html };
}

async function processosPendentes(agora: Date) {
  const abertos = await prisma.fiscalizacaoProcesso.findMany({
    where: { encerrado: false },
    orderBy: { createdAt: "asc" },
  });
  return abertos.filter((p) => pendenteHoje(p, agora));
}

// Chamado a cada minuto pelo agendador. Envia no máximo um lembrete por horário (08h, 11h, 14h, 17h).
export async function verificarEEnviarAlerta(agora = new Date()): Promise<void> {
  const hora = horarioAtual(agora);
  if (hora === null) return;
  if (!emailConfigurado()) return;
  const para = await destinatarios();
  if (!para.length) return;

  const horario = chaveHorario(agora, hora);
  const tentativas = await prisma.fiscalizacaoAlertaEnvio.findMany({
    where: { horario },
    orderBy: { createdAt: "desc" },
  });
  if (tentativas.some((t) => t.sucesso)) return;
  if (tentativas[0] && agora.getTime() - tentativas[0].createdAt.getTime() < ESPERA_APOS_FALHA_MS) return;

  const pendentes = await processosPendentes(agora);
  if (!pendentes.length) return;

  const msg = montarMensagem(pendentes, false);
  try {
    await enviarEmail({ para, ...msg });
    await prisma.fiscalizacaoAlertaEnvio.create({
      data: { horario, sucesso: true, processos: pendentes.length },
    });
  } catch (e) {
    await prisma.fiscalizacaoAlertaEnvio.create({
      data: { horario, sucesso: false, processos: pendentes.length, erro: String((e as Error).message ?? e) },
    });
  }
}

// Botão "Enviar e-mail de teste": manda na hora, com os processos abertos (ou um exemplo, se não houver).
export async function enviarAlertaTeste(): Promise<void> {
  const para = await destinatarios();
  if (!para.length) throw new Error("Cadastre pelo menos um e-mail para receber o lembrete.");
  const abertos = await prisma.fiscalizacaoProcesso.findMany({ where: { encerrado: false }, orderBy: { createdAt: "asc" } });
  const lista: ProcessoAlerta[] = abertos.length
    ? abertos
    : [{ numero: "000000", assunto: "Exemplo de processo", ultimoOkEm: null, ultimoOkPorNome: null }];
  await enviarEmail({ para, ...montarMensagem(lista, true) });
}
