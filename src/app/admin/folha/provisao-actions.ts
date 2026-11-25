"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { MSG_EMPRESA_NAO_LIBERADA, podeEmpresa, requirePermissao } from "@/lib/session";
import { logAction } from "@/lib/audit";
import { carregarContexto13, carregarPensoes, carregarProgramacaoFerias, paraFuncionario } from "@/lib/folha/dados";
import { provisionar13, provisionarComPrevia, provisionarMensal, valoresDaFolha, type AliquotasProvisao, type ValoresProvisao } from "@/lib/folha/provisao";

export type ResultadoProvisao = {
  empresaNome: string;
  competencia: string;
  tipo: "mensal" | "13_2";
  baseCompetencia: string; // última folha importada usada como base
  mesesMedia: string[];
  aliquotas: AliquotasProvisao;
  receita: { competencia: string; valor: number } | null;
  previsto: ValoresProvisao;
  avisos: string[];
  // Folha do ERP da competência, quando já importada — na folha mensal é a prévia calculada antes do
  // fechamento (ou a definitiva, depois), e a provisão parte dela; no 13º, a simulação/definitiva.
  real: (ValoresProvisao & { simulado: boolean; importadaEm: string }) | null;
  // "previa" = provisão a partir da folha da competência importada; "projecao" = só pelas médias.
  modo: "previa" | "projecao";
  // Mês anterior real (a base), para comparação na folha mensal.
  anterior: ValoresProvisao | null;
  // Provisão registrada como enviada ao financeiro (a última), para comparar com a folha definitiva.
  registrada: ProvisaoEnviada | null;
};

export type ProvisaoEnviada = {
  valores: ValoresProvisao;
  aliquotas: AliquotasProvisao;
  modo: "previa" | "projecao";
  baseCompetencia: string;
  folhaImportadaEm: string | null;
  registradaEm: string;
  registradaPor: string;
};

const ordem = (c: string) => Number(c.slice(3, 7)) * 100 + Number(c.slice(0, 2));
const num = (d: { toString(): string } | null) => (d === null ? null : Number(d));

export async function buscarProvisao(
  empresaId: string,
  competencia: string,
  tipo: "mensal" | "13_2"
): Promise<{ data: ResultadoProvisao | null; error: string | null }> {
  const user = await requirePermissao("folha", "consultar");
  if (!(await podeEmpresa(user, empresaId))) return { data: null, error: MSG_EMPRESA_NAO_LIBERADA };
  return calcularProvisao(empresaId, competencia, tipo);
}

// Guarda os valores da provisão deste momento como a enviada ao financeiro (substitui a anterior da
// mesma competência). Recalcula no servidor — não confia em valores vindos da tela.
export async function registrarProvisaoEnviada(
  empresaId: string,
  competencia: string,
  tipo: "mensal" | "13_2"
): Promise<{ error: string | null }> {
  const user = await requirePermissao("folha", "operar");
  if (!(await podeEmpresa(user, empresaId))) return { error: MSG_EMPRESA_NAO_LIBERADA };
  const r = await calcularProvisao(empresaId, competencia, tipo);
  if (!r.data) return { error: r.error ?? "Não foi possível calcular a provisão." };
  const d = r.data;
  const valores = JSON.stringify({
    valores: d.previsto,
    aliquotas: d.aliquotas,
    modo: d.modo,
    baseCompetencia: d.baseCompetencia,
    folhaImportadaEm: d.real?.importadaEm ?? null,
  });
  await prisma.provisaoRegistrada.upsert({
    where: { empresaId_competencia_tipo: { empresaId, competencia: d.competencia, tipo } },
    create: { empresaId, competencia: d.competencia, tipo, valores, registradoPorId: user.id, registradoPorNome: user.name },
    update: { valores, registradoPorId: user.id, registradoPorNome: user.name },
  });
  await logAction(user.id, "provisao.registrar", empresaId, { competencia: d.competencia, tipo, modo: d.modo });
  return { error: null };
}

async function calcularProvisao(
  empresaId: string,
  competencia: string,
  tipo: "mensal" | "13_2"
): Promise<{ data: ResultadoProvisao | null; error: string | null }> {
  if (!/^(0[1-9]|1[0-2])\/\d{4}$/.test(competencia)) return { data: null, error: "Informe a competência no formato MM/AAAA." };

  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
  if (!empresa) return { data: null, error: "Empresa não encontrada." };
  const aliquotas: AliquotasProvisao = {
    patronal: num(empresa.provisaoPatronal) ?? 20,
    cprbReceita: num(empresa.provisaoCprbReceita) ?? 0,
    terceiros: num(empresa.provisaoTerceiros) ?? 5.8,
    rat: num(empresa.provisaoRat),
  };

  const [mes, ano] = competencia.split("/").map(Number);
  // Na 2ª parcela do 13º a base é a última folha mensal até novembro do ano.
  const limite = tipo === "13_2" ? ano * 100 + 11 : ano * 100 + mes - 1;
  const mensais = (
    await prisma.folhaPagamento.findMany({ where: { empresaId, tipo: "mensal" }, select: { id: true, competencia: true } })
  )
    .filter((f) => ordem(f.competencia) <= limite)
    .sort((a, b) => ordem(b.competencia) - ordem(a.competencia))
    .slice(0, 3);
  if (mensais.length === 0) return { data: null, error: "Nenhuma folha mensal importada antes dessa competência para servir de base." };

  const folhas = await Promise.all(
    mensais.map((f) => prisma.folhaPagamento.findUnique({ where: { id: f.id }, include: { itens: true } }))
  );
  const ultimas = folhas.map((f) => (f?.itens ?? []).map(paraFuncionario));
  const base = ultimas[0];
  const baseCompetencia = mensais[0].competencia;

  // Desligados (cadastro) até o fim da competência; admitidos depois da base que ainda não estão nela.
  const [mesB, anoB] = baseCompetencia.split("/").map(Number);
  const fimBase = new Date(Date.UTC(anoB, mesB, 0, 23, 59, 59));
  const fimAlvo = new Date(Date.UTC(ano, mes, 0, 23, 59, 59));
  const funcionarios = await prisma.funcionario.findMany({
    where: { empresaId },
    select: { matricula: true, nome: true, cpf: true, salario: true, status: true, dataAdmissao: true, dataDesligamento: true, cargo: { select: { nome: true } } },
  });
  const naBase = new Set(base.map((f) => f.matricula));
  const desligados = new Set(
    funcionarios
      .filter((f) => f.status === "desligado" && f.dataDesligamento && f.dataDesligamento <= fimAlvo)
      .map((f) => f.matricula.padStart(6, "0"))
  );
  const admitidos = funcionarios
    .filter((f) => f.status !== "desligado" && f.dataAdmissao > fimBase && f.dataAdmissao <= fimAlvo && !naBase.has(f.matricula.padStart(6, "0")))
    .map((f) => ({
      matricula: f.matricula.padStart(6, "0"),
      nome: f.nome,
      funcao: f.cargo?.nome ?? "",
      salario: Number(f.salario),
      admissao: f.dataAdmissao.toISOString(),
    }));

  const receitas = await prisma.operacaoMensal.findMany({ where: { empresaId, receita: { gt: 0 } }, select: { competencia: true, receita: true } });
  const ultimaReceita = receitas.sort((a, b) => ordem(b.competencia) - ordem(a.competencia))[0];
  const receita = ultimaReceita ? { competencia: ultimaReceita.competencia, valor: Number(ultimaReceita.receita) } : null;
  const receitaDa = (c: string) => {
    const r = receitas.find((x) => x.competencia === c);
    return r ? Number(r.receita) : receita?.valor ?? null;
  };

  let previsto: ValoresProvisao & { avisos: string[] };
  let real: ResultadoProvisao["real"] = null;
  let anterior: ValoresProvisao | null = null;

  let modo: ResultadoProvisao["modo"] = "projecao";
  if (tipo === "mensal") {
    const folhaCompetencia = await prisma.folhaPagamento.findUnique({
      where: { empresaId_competencia_tipo: { empresaId, competencia, tipo: "mensal" } },
      include: { itens: true },
    });
    const pensoes = await carregarPensoes(empresaId);
    if (folhaCompetencia) {
      // Folha prévia (ou definitiva) do ERP já importada: a provisão parte dela.
      modo = "previa";
      const itens = folhaCompetencia.itens.map(paraFuncionario);
      previsto = provisionarComPrevia({ competencia, previa: itens, ultimas, pensoes, aliquotas, receita: receitaDa(competencia) });
      real = { ...valoresDaFolha(itens, "mensal", aliquotas, receitaDa(competencia)), simulado: folhaCompetencia.simulado, importadaEm: folhaCompetencia.updatedAt.toISOString() };
    } else {
      const [programacao, arquivoConsignado] = await Promise.all([
        carregarProgramacaoFerias(empresaId),
        prisma.consignadoImportacao.findUnique({ where: { empresaId_competencia: { empresaId, competencia } }, include: { contratos: true } }),
      ]);
      let consignadoArquivo: Map<string, number> | null = null;
      if (arquivoConsignado) {
        const matriculaPorCpf = new Map(
          funcionarios.filter((f) => f.cpf).map((f) => [f.cpf!.replace(/\D/g, "").padStart(11, "0"), f.matricula.padStart(6, "0")])
        );
        consignadoArquivo = new Map();
        for (const c of arquivoConsignado.contratos) {
          const matricula = matriculaPorCpf.get(c.cpf);
          if (matricula) consignadoArquivo.set(matricula, (consignadoArquivo.get(matricula) ?? 0) + Number(c.valorParcela));
        }
      }
      previsto = provisionarMensal({
        competencia,
        base,
        ultimas,
        programacao,
        admitidos,
        desligados,
        pensoes,
        aliquotas,
        receita: receita?.valor ?? null,
        consignadoArquivo,
      });
    }
    anterior = valoresDaFolha(base, "mensal", aliquotas, receitaDa(baseCompetencia));
  } else {
    const ctx = await carregarContexto13(empresaId, `12/${ano}`, "13_2");
    previsto = provisionar13({ ano, base, ultimas, ctx, desligados, aliquotas });
    const folhaReal = await prisma.folhaPagamento.findUnique({
      where: { empresaId_competencia_tipo: { empresaId, competencia: `12/${ano}`, tipo: "13_2" } },
      include: { itens: true },
    });
    if (folhaReal)
      real = { ...valoresDaFolha(folhaReal.itens.map(paraFuncionario), "13_2", aliquotas, null), simulado: folhaReal.simulado, importadaEm: folhaReal.updatedAt.toISOString() };
  }

  const { avisos, ...valores } = previsto;
  if (aliquotas.rat === null) avisos.unshift("RAT ainda não informado — o INSS da empresa está sem o RAT. Preencha nas alíquotas.");

  const competenciaFinal = tipo === "13_2" ? `12/${ano}` : competencia;
  const reg = await prisma.provisaoRegistrada.findUnique({
    where: { empresaId_competencia_tipo: { empresaId, competencia: competenciaFinal, tipo } },
  });
  let registrada: ProvisaoEnviada | null = null;
  if (reg) {
    const j = JSON.parse(reg.valores) as Omit<ProvisaoEnviada, "registradaEm" | "registradaPor">;
    registrada = { ...j, registradaEm: reg.updatedAt.toISOString(), registradaPor: reg.registradoPorNome };
  }

  return {
    data: {
      empresaNome: empresa.nome,
      competencia: competenciaFinal,
      tipo,
      baseCompetencia,
      mesesMedia: mensais.map((m) => m.competencia).reverse(),
      aliquotas,
      receita,
      previsto: valores,
      avisos,
      real,
      anterior,
      modo,
      registrada,
    },
    error: null,
  };
}

const aliquotasSchema = z.object({
  patronal: z.number().finite().min(0).max(100),
  cprbReceita: z.number().finite().min(0).max(100),
  terceiros: z.number().finite().min(0).max(100),
  rat: z.number().finite().min(0).max(100).nullable(),
});

export async function salvarAliquotasProvisao(empresaId: string, dados: AliquotasProvisao): Promise<{ error: string | null }> {
  const user = await requirePermissao("folha", "operar");
  if (!(await podeEmpresa(user, empresaId))) return { error: MSG_EMPRESA_NAO_LIBERADA };
  const parsed = aliquotasSchema.safeParse(dados);
  if (!parsed.success) return { error: "Alíquotas inválidas (use percentuais entre 0 e 100)." };
  const d = parsed.data;
  await prisma.empresa.update({
    where: { id: empresaId },
    data: { provisaoPatronal: d.patronal, provisaoCprbReceita: d.cprbReceita, provisaoTerceiros: d.terceiros, provisaoRat: d.rat },
  });
  await logAction(user.id, "provisao.aliquotas", empresaId, d);
  return { error: null };
}
