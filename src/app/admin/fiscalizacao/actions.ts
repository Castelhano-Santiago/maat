"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissao } from "@/lib/session";
import { logAction } from "@/lib/audit";
import { emailConfigurado } from "@/lib/email";
import { enviarAlertaTeste, salvarConfig } from "@/lib/fiscalizacao-alertas";

const CAMINHO = "/admin/fiscalizacao";

const processoSchema = z.object({
  numero: z.string().trim().min(1, "Informe o número do processo"),
  assunto: z.string().trim().min(1, "Informe o assunto"),
});

export async function criarProcesso(input: { numero: string; assunto: string }) {
  const user = await requirePermissao("fiscalizacao", "operar");
  const data = processoSchema.parse(input);
  const p = await prisma.fiscalizacaoProcesso.create({ data });
  await logAction(user.id, "fiscalizacao.create", p.id, data);
  revalidatePath(CAMINHO);
  return { error: null };
}

export async function editarProcesso(id: string, input: { numero: string; assunto: string }) {
  const user = await requirePermissao("fiscalizacao", "operar");
  const data = processoSchema.parse(input);
  await prisma.fiscalizacaoProcesso.update({ where: { id }, data });
  await logAction(user.id, "fiscalizacao.update", id, data);
  revalidatePath(CAMINHO);
  return { error: null };
}

export async function darOk(id: string, observacao: string) {
  const user = await requirePermissao("fiscalizacao", "operar");
  const agora = new Date();
  await prisma.$transaction([
    prisma.fiscalizacaoProcesso.update({
      where: { id },
      data: { ultimoOkEm: agora, ultimoOkPorNome: user.name },
    }),
    prisma.fiscalizacaoConferencia.create({
      data: { processoId: id, usuarioNome: user.name, observacao: observacao.trim() || null },
    }),
  ]);
  await logAction(user.id, "fiscalizacao.ok", id);
  revalidatePath(CAMINHO);
  return { error: null };
}

export async function encerrarProcesso(id: string, encerrar: boolean) {
  const user = await requirePermissao("fiscalizacao", "operar");
  await prisma.fiscalizacaoProcesso.update({
    where: { id },
    data: { encerrado: encerrar, encerradoEm: encerrar ? new Date() : null },
  });
  await logAction(user.id, encerrar ? "fiscalizacao.encerrar" : "fiscalizacao.reabrir", id);
  revalidatePath(CAMINHO);
  return { error: null };
}

export async function excluirProcesso(id: string) {
  const user = await requirePermissao("fiscalizacao", "operar");
  await prisma.fiscalizacaoProcesso.delete({ where: { id } });
  await logAction(user.id, "fiscalizacao.delete", id);
  revalidatePath(CAMINHO);
  return { error: null };
}

const emailOpcional = z.union([z.literal(""), z.string().trim().email("E-mail inválido")]);

export async function salvarEmails(input: { email1: string; email2: string }) {
  const user = await requirePermissao("fiscalizacao", "operar");
  const r = z.object({ email1: emailOpcional, email2: emailOpcional }).safeParse(input);
  if (!r.success) return { error: r.error.issues[0]?.message ?? "E-mail inválido" };
  await salvarConfig(r.data.email1.trim(), r.data.email2.trim());
  await logAction(user.id, "fiscalizacao.config", undefined, r.data);
  revalidatePath(CAMINHO);
  return { error: null };
}

export async function testarEmail() {
  await requirePermissao("fiscalizacao", "operar");
  if (!emailConfigurado()) {
    return { error: "A conta de e-mail que envia os lembretes ainda não foi configurada no sistema." };
  }
  try {
    await enviarAlertaTeste();
    return { error: null };
  } catch (e) {
    return { error: `Não foi possível enviar: ${(e as Error).message}` };
  }
}
