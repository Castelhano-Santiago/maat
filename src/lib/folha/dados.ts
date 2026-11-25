// Carga dos dados já importados usados na conferência e na provisão da folha (servidor apenas —
// não é server action: as funções aqui não verificam permissão; quem chama já verificou).

import "server-only";
import { prisma } from "@/lib/prisma";
import type { FuncionarioFolha } from "@/lib/parsers/folha-pagamento";
import type { BancoHorasCompetencia } from "@/lib/folha/conferencia";
import type { Contexto13, MesHistorico } from "@/lib/folha/conferencia-13";
import { CODIGOS_MEDIA_FERIAS, type HistoricoFolhas, type ProgramacaoFerias } from "@/lib/folha/ferias-programacao";
import type { AfastamentosPorMatricula } from "@/lib/folha/rescisao-motivo";
import type { CadastroPensao, CadastroPensoes, ModalidadePensao } from "@/lib/folha/pensao";

// Horas "A Pagar" do Banco de Horas da empresa na competência, para conferir a hora extra 50% da
// folha. null quando o banco de horas desse mês ainda não foi importado.
export async function carregarBancoHoras(empresaId: string, competencia: string): Promise<BancoHorasCompetencia | null> {
  const apuracoes = await prisma.bancoHorasApuracao.findMany({
    where: { competencia, funcionario: { empresaId } },
    select: { pagoNoMes: true, saldoFinal: true, funcionario: { select: { matricula: true } } },
  });
  if (apuracoes.length === 0) return null;
  return new Map(
    apuracoes.map((a) => {
      const aPagar = Number(a.pagoNoMes);
      return [a.funcionario.matricula.padStart(6, "0"), { aPagar, aPagarRescisao: aPagar + Math.max(Number(a.saldoFinal), 0) }];
    })
  );
}

// Programação de Férias da empresa (período aquisitivo, faltas, dias de direito), por matrícula.
export async function carregarProgramacaoFerias(empresaId: string): Promise<ProgramacaoFerias | null> {
  const periodos = await prisma.ferias.findMany({
    where: { funcionario: { empresaId } },
    select: {
      periodoAquisitivoInicio: true,
      periodoAquisitivoFim: true,
      faltas: true,
      diasDireito: true,
      gozoInicio: true,
      gozoFim: true,
      diasAbono: true,
      funcionario: { select: { matricula: true } },
    },
  });
  if (periodos.length === 0) return null;
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const mapa: ProgramacaoFerias = new Map();
  for (const p of periodos) {
    const matricula = p.funcionario.matricula.padStart(6, "0");
    mapa.set(matricula, [
      ...(mapa.get(matricula) ?? []),
      {
        inicio: iso(p.periodoAquisitivoInicio)!,
        fim: iso(p.periodoAquisitivoFim)!,
        faltas: p.faltas,
        diasDireito: p.diasDireito,
        gozoInicio: iso(p.gozoInicio),
        gozoFim: iso(p.gozoFim),
        diasAbono: p.diasAbono,
      },
    ]);
  }
  return mapa;
}

// Folhas mensais já importadas da empresa (salário e variáveis por mês), para as médias de férias,
// e afastamentos (aba de afastamentos + situação "Afastado em" das folhas), para o aviso proporcional.
export async function carregarHistoricoFolhas(empresaId: string): Promise<{ historico: HistoricoFolhas; afastamentos: AfastamentosPorMatricula }> {
  const [folhas, historicoAfastamentos] = await Promise.all([
    prisma.folhaPagamento.findMany({
      where: { empresaId, tipo: "mensal" },
      select: { competencia: true, itens: { select: { matricula: true, salarioBase: true, situacao: true, eventos: true } } },
    }),
    prisma.afastamentoHistorico.findMany({
      where: { funcionario: { empresaId } },
      select: { dataInicio: true, dataFim: true, funcionario: { select: { matricula: true } } },
    }),
  ]);
  const historico: HistoricoFolhas = { competencias: new Set(), porMatricula: new Map() };
  const afastamentos: AfastamentosPorMatricula = new Map();
  const adicionar = (matricula: string, inicio: string, fim: string | null) => {
    const lista = afastamentos.get(matricula) ?? [];
    const existente = lista.find((a) => a.inicio === inicio);
    if (existente) {
      if (fim && (!existente.fim || fim > existente.fim)) existente.fim = fim;
    } else lista.push({ inicio, fim });
    afastamentos.set(matricula, lista);
  };
  for (const a of historicoAfastamentos) {
    adicionar(a.funcionario.matricula.padStart(6, "0"), a.dataInicio.toISOString().slice(0, 10), a.dataFim ? a.dataFim.toISOString().slice(0, 10) : null);
  }
  for (const folha of folhas) {
    const [mes, ano] = folha.competencia.split("/");
    const chave = `${ano}-${mes}`;
    const fimDoMes = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10);
    historico.competencias.add(chave);
    for (const item of folha.itens) {
      const eventos: { codigo: string; valor: number }[] = JSON.parse(item.eventos);
      const variaveis = eventos.filter((e) => CODIGOS_MEDIA_FERIAS.includes(e.codigo)).reduce((a, e) => a + e.valor, 0);
      const porMes = historico.porMatricula.get(item.matricula) ?? new Map();
      porMes.set(chave, { salario: Number(item.salarioBase), variaveis });
      historico.porMatricula.set(item.matricula, porMes);
      const afastado = item.situacao.match(/^Afastado em (\d{2})\/(\d{2})\/(\d{4})/i);
      if (afastado) adicionar(item.matricula, `${afastado[3]}-${afastado[2]}-${afastado[1]}`, fimDoMes);
    }
  }
  return { historico, afastamentos };
}

export type ItemGravado = {
  matricula: string;
  nome: string;
  funcao: string;
  situacao: string;
  divisao: string;
  salarioBase: { toString(): string };
  admissao: string;
  gozoInicio: string | null;
  gozoFim: string | null;
  eventos: string;
};

export function paraFuncionario(i: ItemGravado): FuncionarioFolha {
  return {
    matricula: i.matricula,
    nome: i.nome,
    funcao: i.funcao,
    situacao: i.situacao,
    divisao: i.divisao,
    salarioBase: Number(i.salarioBase),
    admissao: i.admissao,
    gozoInicio: i.gozoInicio,
    gozoFim: i.gozoFim,
    eventos: JSON.parse(i.eventos),
  };
}

// Cadastros de pensão da empresa, por matrícula — usados na conferência da folha.
export async function carregarPensoes(empresaId: string): Promise<CadastroPensoes> {
  const lista = await prisma.pensaoAlimenticia.findMany({ where: { empresaId }, orderBy: { createdAt: "asc" } });
  const mapa: CadastroPensoes = new Map();
  for (const p of lista) {
    const cadastro: CadastroPensao = {
      modalidade: p.modalidade as ModalidadePensao,
      percentual: p.percentual === null ? null : Number(p.percentual),
      valorFixo: p.valorFixo === null ? null : Number(p.valorFixo),
      incide13: p.incide13,
      incideFerias: p.incideFerias,
    };
    mapa.set(p.matricula, [...(mapa.get(p.matricula) ?? []), cadastro]);
  }
  return mapa;
}

// Para o 13º: folhas mensais do ano (avos, médias, adiantamento pago nas férias) e, na 2ª
// parcela, a 1ª parcela do mesmo ano.
export async function carregarContexto13(empresaId: string, competencia: string, tipo: "13_1" | "13_2"): Promise<Contexto13> {
  const ano = competencia.split("/")[1];
  const mensais = await prisma.folhaPagamento.findMany({
    where: { empresaId, tipo: "mensal", competencia: { endsWith: `/${ano}` } },
    include: { itens: true },
  });
  const historico = new Map<string, MesHistorico[]>();
  for (const f of mensais) {
    for (const i of f.itens) {
      const lista = historico.get(i.matricula) ?? [];
      lista.push({ competencia: f.competencia, situacao: i.situacao, gozoInicio: i.gozoInicio, gozoFim: i.gozoFim, salario: Number(i.salarioBase), eventos: JSON.parse(i.eventos) });
      historico.set(i.matricula, lista);
    }
  }
  let primeiraParcela: Contexto13["primeiraParcela"] = null;
  if (tipo === "13_2") {
    const primeira = await prisma.folhaPagamento.findFirst({
      where: { empresaId, tipo: "13_1", competencia: { endsWith: `/${ano}` } },
      include: { itens: true },
      orderBy: { updatedAt: "desc" },
    });
    if (primeira) primeiraParcela = new Map(primeira.itens.map((i) => [i.matricula, paraFuncionario(i)]));
  }
  // Dezembro do ano anterior: entra no período das médias do 13º (dez a nov).
  let dezembroAnterior: Contexto13["dezembroAnterior"] = null;
  if (tipo === "13_2") {
    const dez = await prisma.folhaPagamento.findFirst({
      where: { empresaId, tipo: "mensal", competencia: `12/${Number(ano) - 1}` },
      include: { itens: true },
    });
    if (dez) {
      dezembroAnterior = new Map(
        dez.itens.map((i) => [
          i.matricula,
          { competencia: dez.competencia, situacao: i.situacao, gozoInicio: i.gozoInicio, gozoFim: i.gozoFim, salario: Number(i.salarioBase), eventos: JSON.parse(i.eventos) },
        ])
      );
    }
  }
  const outraEmpresa = tipo === "13_2" ? await carregarTransferidos(empresaId, ano) : null;
  const pensoes = tipo === "13_2" ? await carregarPensoes(empresaId) : undefined;
  return { historico, mesesImportados: new Set(mensais.map((f) => Number(f.competencia.slice(0, 2)))), primeiraParcela, dezembroAnterior, outraEmpresa, pensoes };
}

// Transferidos entre empresas do grupo (ex.: Pantanal → Rápido): o ERP soma na média do 13º as
// variáveis da empresa anterior. Liga pelo nome (a matrícula muda) e só quando os meses das duas
// empresas não se sobrepõem — dois cadastros ao mesmo tempo seriam pessoas diferentes (homônimos).
export async function carregarTransferidos(empresaId: string, ano: string): Promise<Contexto13["outraEmpresa"]> {
  const competencias = [`12/${Number(ano) - 1}`, ...Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, "0")}/${ano}`)];
  const doGrupo = await prisma.folhaPagamento.findMany({
    where: { tipo: "mensal", competencia: { in: competencias } },
    include: { empresa: { select: { nome: true } }, itens: true },
  });
  const norm = (n: string) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
  // Nome → matrícula na empresa atual, e competências em que a pessoa aparece nela.
  const atual = new Map<string, { matricula: string; meses: Set<string> }>();
  for (const f of doGrupo.filter((f) => f.empresaId === empresaId)) {
    for (const i of f.itens) {
      const chave = norm(i.nome);
      const reg = atual.get(chave) ?? { matricula: i.matricula, meses: new Set<string>() };
      reg.meses.add(f.competencia);
      atual.set(chave, reg);
    }
  }
  const resultado = new Map<string, { empresa: string; matricula: string; meses: MesHistorico[] }>();
  const sobrepoe = new Set<string>();
  for (const f of doGrupo.filter((f) => f.empresaId !== empresaId)) {
    for (const i of f.itens) {
      const chave = norm(i.nome);
      const reg = atual.get(chave);
      if (!reg) continue;
      if (reg.meses.has(f.competencia)) {
        sobrepoe.add(reg.matricula);
        continue;
      }
      const r = resultado.get(reg.matricula) ?? { empresa: f.empresa.nome, matricula: i.matricula, meses: [] };
      r.meses.push({ competencia: f.competencia, situacao: i.situacao, gozoInicio: i.gozoInicio, gozoFim: i.gozoFim, salario: Number(i.salarioBase), eventos: JSON.parse(i.eventos) });
      resultado.set(reg.matricula, r);
    }
  }
  for (const m of sobrepoe) resultado.delete(m);
  return resultado.size ? resultado : null;
}

