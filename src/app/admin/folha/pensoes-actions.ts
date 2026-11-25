"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { MSG_EMPRESA_NAO_LIBERADA, podeEmpresa, requirePermissao } from "@/lib/session";
import { logAction } from "@/lib/audit";
import { parametrosDoAno } from "@/lib/folha/parametros";
import type { CadastroPensao, ModalidadePensao } from "@/lib/folha/pensao";

export type LinhaPensao = {
  matricula: string;
  nome: string;
  // Último desconto encontrado nas folhas importadas.
  ultimo: { competencia: string; tipo: string; evento: string; percentual: number | null; valor: number } | null;
  // Modalidade que os valores da folha sugerem (para pré-preencher quem não tem cadastro).
  sugestao: { modalidade: ModalidadePensao; percentual: number | null; valorFixo: number | null } | null;
  // Pensões cadastradas (pode haver mais de uma por colaborador).
  cadastros: (CadastroPensao & { id: string; beneficiario: string | null; observacao: string | null })[];
};

const ordemCompetencia = (c: string) => Number(c.slice(3, 7)) * 100 + Number(c.slice(0, 2));

// Todos os colaboradores da empresa com desconto de pensão nas folhas importadas, mais os que já têm
// cadastro (mesmo sem desconto recente).
export async function listarPensoes(empresaId: string): Promise<{ linhas: LinhaPensao[]; error: string | null }> {
  const user = await requirePermissao("folha", "consultar");
  if (!(await podeEmpresa(user, empresaId))) return { linhas: [], error: MSG_EMPRESA_NAO_LIBERADA };

  const [folhas, cadastros] = await Promise.all([
    prisma.folhaPagamento.findMany({
      where: { empresaId },
      select: { competencia: true, tipo: true, itens: { select: { matricula: true, nome: true, eventos: true } } },
    }),
    prisma.pensaoAlimenticia.findMany({ where: { empresaId }, orderBy: { createdAt: "asc" } }),
  ]);

  type Ocorrencia = { competencia: string; tipo: string; evento: string; percentual: number | null; valor: number };
  const porMatricula = new Map<string, { nome: string; ocorrencias: Ocorrencia[] }>();
  for (const folha of folhas) {
    for (const item of folha.itens) {
      const eventos: { codigo: string; referencia: number | null; valor: number }[] = JSON.parse(item.eventos);
      for (const e of eventos) {
        if (!["00469", "00470", "00551"].includes(e.codigo) || e.valor <= 0) continue;
        const reg = porMatricula.get(item.matricula) ?? { nome: item.nome, ocorrencias: [] };
        reg.ocorrencias.push({ competencia: folha.competencia, tipo: folha.tipo, evento: e.codigo, percentual: e.referencia, valor: e.valor });
        porMatricula.set(item.matricula, reg);
      }
    }
  }

  const linhas = new Map<string, LinhaPensao>();
  for (const [matricula, { nome, ocorrencias }] of porMatricula) {
    // Mais recente primeiro; na mesma competência, o salário (00469) antes das férias e do 13º.
    const ordenadas = [...ocorrencias].sort(
      (a, b) => ordemCompetencia(b.competencia) - ordemCompetencia(a.competencia) || a.evento.localeCompare(b.evento)
    );
    const ultimo = ordenadas[0];
    linhas.set(matricula, { matricula, nome, ultimo, sugestao: sugerir(ordenadas), cadastros: [] });
  }
  for (const c of cadastros) {
    const linha = linhas.get(c.matricula) ?? { matricula: c.matricula, nome: c.nome, ultimo: null, sugestao: null, cadastros: [] };
    linha.cadastros.push({
      id: c.id,
      modalidade: c.modalidade as ModalidadePensao,
      percentual: c.percentual === null ? null : Number(c.percentual),
      valorFixo: c.valorFixo === null ? null : Number(c.valorFixo),
      incide13: c.incide13,
      incideFerias: c.incideFerias,
      beneficiario: c.beneficiario,
      observacao: c.observacao,
    });
    linhas.set(c.matricula, linha);
  }
  return { linhas: [...linhas.values()].sort((a, b) => a.nome.localeCompare(b.nome)), error: null };
}

// Sugestão a partir dos descontos de salário (00469) em meses cheios: o mesmo valor que é o percentual
// × salário mínimo do ano → % do mínimo; o mesmo valor sem percentual → valor fixo; percentual com
// valores que variam → % dos rendimentos líquidos.
function sugerir(ocorrencias: { competencia: string; evento: string; percentual: number | null; valor: number }[]): LinhaPensao["sugestao"] {
  const salario = ocorrencias.filter((o) => o.evento === "00469");
  const base = salario.length ? salario : ocorrencias;
  const comPercentual = base.find((o) => o.percentual && o.percentual <= 100);
  if (comPercentual?.percentual) {
    const pct = comPercentual.percentual;
    const bateMinimo = base.some((o) => {
      const minimo = parametrosDoAno(Number(o.competencia.slice(3, 7))).parametros.salarioMinimo;
      return Math.abs(o.valor - (pct / 100) * minimo) <= 0.1;
    });
    return { modalidade: bateMinimo ? "salario_minimo" : "liquido", percentual: pct, valorFixo: null };
  }
  const valores = base.map((o) => o.valor);
  const maisComum = moda(valores);
  if (maisComum !== null && valores.filter((v) => v === maisComum).length >= 2) {
    return { modalidade: "fixo", percentual: null, valorFixo: maisComum };
  }
  return null;
}

function moda(valores: number[]): number | null {
  const contagem = new Map<number, number>();
  for (const v of valores) contagem.set(v, (contagem.get(v) ?? 0) + 1);
  return [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const pensaoSchema = z
  .object({
    // Sem id = nova pensão (o colaborador pode ter mais de uma).
    id: z.string().min(1).max(40).nullable(),
    matricula: z.string().regex(/^\d{6}$/),
    nome: z.string().min(1).max(200),
    modalidade: z.enum(["salario_minimo", "liquido", "fixo"]),
    percentual: z.number().finite().gt(0).max(100).nullable(),
    valorFixo: z.number().finite().gt(0).max(100000).nullable(),
    incide13: z.boolean(),
    incideFerias: z.boolean(),
    beneficiario: z.string().max(200).nullable(),
    observacao: z.string().max(500).nullable(),
  })
  .refine((d) => (d.modalidade === "fixo" ? d.valorFixo !== null : d.percentual !== null), {
    message: "Informe o percentual (ou o valor, na modalidade valor fixo).",
  });

export async function salvarPensao(empresaId: string, dados: z.infer<typeof pensaoSchema>): Promise<{ error: string | null }> {
  const user = await requirePermissao("folha", "operar");
  if (!(await podeEmpresa(user, empresaId))) return { error: MSG_EMPRESA_NAO_LIBERADA };
  const parsed = pensaoSchema.safeParse(dados);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const d = parsed.data;
  const valores = {
    nome: d.nome,
    modalidade: d.modalidade,
    percentual: d.modalidade === "fixo" ? null : d.percentual,
    valorFixo: d.modalidade === "fixo" ? d.valorFixo : null,
    incide13: d.incide13,
    incideFerias: d.incideFerias,
    beneficiario: d.beneficiario?.trim() || null,
    observacao: d.observacao?.trim() || null,
  };
  if (d.id) {
    const { count } = await prisma.pensaoAlimenticia.updateMany({ where: { id: d.id, empresaId, matricula: d.matricula }, data: valores });
    if (count === 0) return { error: "Cadastro de pensão não encontrado — recarregue a tela." };
  } else {
    await prisma.pensaoAlimenticia.create({ data: { empresaId, matricula: d.matricula, ...valores } });
  }
  await logAction(user.id, "pensao.salvar", empresaId, { id: d.id, matricula: d.matricula, ...valores });
  return { error: null };
}

export async function excluirPensao(empresaId: string, id: string): Promise<{ error: string | null }> {
  const user = await requirePermissao("folha", "operar");
  if (!(await podeEmpresa(user, empresaId))) return { error: MSG_EMPRESA_NAO_LIBERADA };
  const alvo = await prisma.pensaoAlimenticia.findFirst({ where: { id, empresaId } });
  if (!alvo) return { error: "Cadastro de pensão não encontrado — recarregue a tela." };
  await prisma.pensaoAlimenticia.delete({ where: { id } });
  await logAction(user.id, "pensao.excluir", empresaId, { id, matricula: alvo.matricula });
  return { error: null };
}
