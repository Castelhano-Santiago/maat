// Conferência da folha de 13º salário (relatório "FOLHA DE DÉCIMO TERCEIRO" do ERP), 1ª e 2ª
// parcela. Além das contas do próprio arquivo, cruza com as folhas mensais do ano já importadas:
// avos (meses com 15 dias ou mais), médias de variáveis e o adiantamento pago nas férias.

import type { EventoFolha, FuncionarioFolha } from "../parsers/folha-pagamento";
import { calcularInss, calcularIr, type Categoria, type Critica, type ResultadoFuncionario } from "./conferencia";
import { parametrosDoAno, type ParametrosFolha } from "./parametros";
import { conferirPensao13, type CadastroPensoes } from "./pensao";

// Folha mensal de um funcionário num mês do ano do 13º.
export type MesHistorico = {
  competencia: string; // "MM/AAAA"
  situacao: string;
  gozoInicio: string | null;
  gozoFim: string | null;
  salario?: number; // salário-base do mês (para achar o salário-hora atual)
  eventos: EventoFolha[];
};

export type Contexto13 = {
  // Folhas mensais do ano por matrícula, e quais meses (1-12) da empresa foram importados.
  historico: Map<string, MesHistorico[]>;
  mesesImportados: Set<number>;
  // Na 2ª parcela: a 1ª parcela do mesmo ano, quando importada.
  primeiraParcela: Map<string, FuncionarioFolha> | null;
  // Folha de dezembro do ano anterior (entra no período das médias: dez a nov), quando importada.
  dezembroAnterior: Map<string, MesHistorico> | null;
  // Transferidos de outra empresa do grupo: meses da empresa anterior (só para as médias do 13º).
  outraEmpresa?: Map<string, { empresa: string; matricula: string; meses: MesHistorico[] }> | null;
  // Cadastro de pensões da empresa (aba Pensões); undefined = não conferir a pensão.
  pensoes?: CadastroPensoes | null;
  // Afastamentos do cadastro (INSS, licença não remunerada...), por matrícula, para os meses ainda
  // sem folha importada. Datas em ms UTC; `fim` = dia do retorno (já trabalhado), null = sem retorno.
  // Licença-maternidade fica de fora (conta como tempo de serviço).
  afastamentos?: Map<string, { inicio: number; fim: number | null }[]>;
};

const TOLERANCIA = 0.02;
// Eventos que entram na média do 13º. Os de horas são valorizados pelo salário-hora atual
// (quantidade × hora atual × percentual); os de valor entram pelo valor pago.
// 00659 = horas extras (banco) pagas a 50%; 00707/00708 = comissão e DSR sobre comissão (promotores
// de venda), pelo valor pago; 00627 = HE 100% do mês anterior, como hora a 100% — conferido contra
// o ERP (010363, 010456). O ERP não conta o repouso s/ adicional noturno do mês anterior (00391), as
// horas de treinamento (00545) nem a diferença de comissão da CCT (00668).
export const EVENTOS_MEDIA = ["00003", "00363", "00627", "00659", "00004", "00126", "00119", "00005", "00006", "00707", "00708"];
const PERCENTUAL_HORAS: Record<string, number> = { "00003": 1.5, "00363": 2, "00627": 2, "00659": 1.5, "00004": 0.2, "00119": 0.2 };
const GRATIFICACAO = 0.4;

const arred = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NOMES_MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function data(s: string): { dia: number; mes: number; ano: number } | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? { dia: Number(m[1]), mes: Number(m[2]), ano: Number(m[3]) } : null;
}

function diasNoMes(mes: number, ano: number) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// Dias de férias (gozo) que caem dentro do mês.
function diasFeriasNoMes(m: MesHistorico, mes: number, ano: number): number {
  const ini = m.gozoInicio ? data(m.gozoInicio) : null;
  const fim = m.gozoFim ? data(m.gozoFim) : null;
  if (!ini || !fim) return 0;
  const a = Math.max(Date.UTC(ini.ano, ini.mes - 1, ini.dia), Date.UTC(ano, mes - 1, 1));
  const b = Math.min(Date.UTC(fim.ano, fim.mes - 1, fim.dia), Date.UTC(ano, mes - 1, diasNoMes(mes, ano)));
  return b < a ? 0 : Math.round((b - a) / 86_400_000) + 1;
}

type CalculoMedia = {
  media: number;
  soma: number; // reajustada
  somaPaga: number; // como foi paga nas folhas
  reajuste: number;
  horaAtual: number;
  periodo: string;
  faltando: string[];
};

// Salário-hora atual (sem percentual) = salário atual ÷ divisor da pessoa (210, 220, 180 na escala
// 12/36...). O divisor sai das horas pagas nas folhas: em cada evento de horas, a hora paga é
// valor ÷ (quantidade × percentual); nos meses com insalubridade/periculosidade a hora paga inclui o
// adicional, que é descontado. Vale o divisor mais frequente (meses pagos ainda com a hora antiga,
// logo após um reajuste, ficam de fora por serem minoria). Sem horas pagas: 220.
// Obs.: o ERP valoriza as horas da média só pelo salário, sem o adicional de periculosidade.
function horaAtualDe(salarioAtual: number, meses: MesHistorico[], salarioDoMes: (m: MesHistorico) => number): number {
  const contagem = new Map<number, number>();
  for (const m of meses) {
    const sal = salarioDoMes(m);
    if (sal <= 0) continue;
    const adicionais = m.eventos.filter((e) => e.codigo === "00005" || e.codigo === "00006").reduce((a, e) => a + e.valor, 0);
    for (const e of m.eventos) {
      const pct = PERCENTUAL_HORAS[e.codigo];
      if (!pct || !e.referencia || e.valor <= 0) continue;
      const horaBase = (e.valor / (e.referencia * pct)) * (sal / (sal + adicionais));
      const divisor = Math.round(sal / horaBase);
      contagem.set(divisor, (contagem.get(divisor) ?? 0) + 1);
    }
  }
  const divisor = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 220;
  return salarioAtual / divisor;
}

export function calcularMedia13(f: FuncionarioFolha, ano: number, ctx: Contexto13): CalculoMedia {
  const doAno = (ctx.historico.get(f.matricula) ?? []).filter((m) => Number(m.competencia.slice(0, 2)) <= 11);
  const dez = ctx.dezembroAnterior?.get(f.matricula);
  const anterior = ctx.outraEmpresa?.get(f.matricula);
  const meses = [...(dez ? [dez] : []), ...doAno, ...(anterior?.meses ?? [])];
  const salarioDoMes = (m: MesHistorico) => m.salario ?? 0;
  const horaAtual = horaAtualDe(f.salarioBase, meses, salarioDoMes);
  let soma = 0;
  let somaPaga = 0;
  for (const m of meses) {
    for (const e of m.eventos) {
      if (!EVENTOS_MEDIA.includes(e.codigo)) continue;
      somaPaga += e.valor;
      const pct = PERCENTUAL_HORAS[e.codigo];
      soma += pct && e.referencia ? arred(e.referencia * horaAtual * pct) : e.valor;
    }
  }
  const faltando: string[] = [];
  if (!ctx.dezembroAnterior) faltando.push(`dez/${ano - 1}`);
  for (let m = 1; m <= 11; m++) if (!ctx.mesesImportados.has(m)) faltando.push(`${NOMES_MES[m - 1]}/${ano}`);
  return {
    media: soma / 12,
    soma,
    somaPaga,
    reajuste: soma - somaPaga,
    horaAtual,
    periodo: `dez/${ano - 1} a nov/${ano}${anterior ? `, incluindo ${anterior.meses.length} mês(es) da ${anterior.empresa} (matr. ${anterior.matricula}), empresa anterior` : ""}`,
    faltando,
  };
}

type CalculoAvos = { avos: number; mesesSemFolha: number[]; meses: string[] };

// Avos do ano: mês conta quando a pessoa tem 15 dias ou mais trabalhados (salário, férias,
// atestado e licença-maternidade contam; afastamento pelo INSS e faltas não). Meses sem folha
// mensal importada são projetados como trabalhados — salvo afastamento/desligamento informado
// na situação do 13º a partir daquele mês e os períodos de afastamento do cadastro (ex.: VPar 010255,
// licença não remunerada até o retorno em 23/11 → novembro com 8 dias, não conta).
export function calcularAvos(f: FuncionarioFolha, ano: number, ctx: Contexto13): CalculoAvos {
  const adm = data(f.admissao);
  // Licença-maternidade conta como tempo de serviço: não interrompe os avos.
  const afast = /MATERNIDADE/i.test(f.situacao) ? null : /^(Afastado|Desligado) em (\d{2}\/\d{2}\/\d{4})/i.exec(f.situacao);
  const saida = afast ? data(afast[2]) : null;
  const historico = ctx.historico.get(f.matricula) ?? [];
  let avos = 0;
  const mesesSemFolha: number[] = [];
  const meses: string[] = [];

  for (let mes = 1; mes <= 12; mes++) {
    if (adm && (adm.ano > ano || (adm.ano === ano && adm.mes > mes))) continue;
    const m = historico.find((h) => Number(h.competencia.slice(0, 2)) === mes);
    let conta: boolean;
    if (m) {
      const ref = (codigo: string) => m.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + (e.referencia ?? 0), 0);
      // Mês parcial (admissão, afastamento ou volta no meio do mês): a folha paga pelo mês comercial de
      // 30 dias, mas o avo exige 15 dias de calendário. Admitido em 16/02 recebe 15 dias e trabalhou
      // 13 (não conta); admitido em 17/08 recebe 14 e trabalhou 15 (conta); afastado em 14/02 recebe
      // 15 e trabalhou 13 (não conta). Ajusta o salário pela diferença entre os dias do mês e 30 —
      // exceto com férias no mês, em que os dias de férias já são contados pelo calendário.
      const ferias = diasFeriasNoMes(m, mes, ano);
      const parcial = ref("00001") > 0 && ref("00001") < 30 && ferias === 0;
      const salarioDias = parcial ? ref("00001") + diasNoMes(mes, ano) - 30 : ref("00001");
      const dias = salarioDias + ref("00188") + ref("00752") + ref("00116") + ferias - ref("00508");
      conta = dias >= 15;
    } else {
      if (!ctx.mesesImportados.has(mes)) mesesSemFolha.push(mes);
      let inicio = 1;
      let fim = diasNoMes(mes, ano);
      if (adm && adm.ano === ano && adm.mes === mes) inicio = adm.dia;
      if (saida && saida.ano === ano) {
        if (saida.mes < mes) fim = 0;
        else if (saida.mes === mes) fim = saida.dia - 1;
      }
      let dias = Math.max(0, fim - inicio + 1);
      // Dias do mês dentro de um afastamento do cadastro (do início até a véspera do retorno).
      for (const a of ctx.afastamentos?.get(f.matricula) ?? []) {
        for (let dia = inicio; dia <= fim; dia++) {
          const t = Date.UTC(ano, mes - 1, dia);
          if (t >= a.inicio && (a.fim === null || t < a.fim)) dias--;
        }
      }
      conta = dias >= 15;
    }
    if (conta) {
      avos++;
      meses.push(NOMES_MES[mes - 1]);
    }
  }
  return { avos, mesesSemFolha, meses };
}

function categoriaDe(f: FuncionarioFolha): Categoria {
  if (/^Desligado/i.test(f.situacao)) return "rescisao";
  if (/^Afastado/i.test(f.situacao)) return "afastado";
  return f.gozoInicio ? "ferias" : "normal";
}

function piorStatus(criticas: Critica[]): ResultadoFuncionario["status"] {
  const ordem: Record<string, number> = { erro: 3, alerta: 2, pendente: 1, ok: 0 };
  return criticas.reduce<ResultadoFuncionario["status"]>(
    (pior, c) => (c.status !== "info" && ordem[c.status] > ordem[pior] ? c.status : pior),
    "ok"
  );
}

function conferirFuncionario13(
  f: FuncionarioFolha,
  tipo: "13_1" | "13_2",
  ano: number,
  ctx: Contexto13,
  p: ParametrosFolha
): ResultadoFuncionario {
  const criticas: Critica[] = [];
  const ev = (codigo: string) => f.eventos.find((e) => e.codigo === codigo);
  const val = (codigo: string) => f.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + e.valor, 0);
  const tem = (codigo: string) => ev(codigo) !== undefined;

  function comparar(regra: string, titulo: string, esperado: number, encontrado: number, explicacao: string, tolerancia = TOLERANCIA) {
    const diferenca = arred(encontrado - esperado);
    const ok = Math.abs(diferenca) <= tolerancia;
    criticas.push({
      regra,
      titulo,
      status: ok ? "ok" : "erro",
      esperado: arred(esperado),
      encontrado: arred(encontrado),
      detalhe: ok ? explicacao : `${explicacao} Diferença de ${fmt(diferenca)}.`,
    });
  }
  const push = (c: Critica) => criticas.push(c);

  const aprendiz = /APRENDIZ/i.test(f.funcao);
  const categoria = categoriaDe(f);
  const codigoParcela = tipo === "13_1" ? "00069" : "00012";
  const parcela = ev(codigoParcela);
  const avosArquivo = parcela?.referencia ?? 0;
  // Em licença-maternidade, a 2ª parcela separa os avos do período de licença no evento 00432 (13º
  // do auxílio-maternidade: pago pela empresa e compensado nas contribuições ao INSS). Os avos do
  // ano são a soma das duas partes.
  const maternidade = ev("00432");
  const avosMaternidade = maternidade?.referencia ?? 0;
  const avosTotal = avosArquivo + avosMaternidade;
  const textoAvosArquivo = avosMaternidade ? `${avosTotal} (${avosArquivo} normais + ${avosMaternidade} de licença-maternidade)` : `${avosArquivo}`;

  // --- Totais -------------------------------------------------------------------------------
  const proventos = f.eventos.filter((e) => e.coluna === "provento").reduce((a, e) => a + e.valor, 0);
  const descontos = f.eventos.filter((e) => e.coluna === "desconto").reduce((a, e) => a + e.valor, 0);
  if (tem("00107")) comparar("totais", "Total de proventos", proventos, val("00107"), "Soma dos proventos do recibo.");
  if (tem("00106")) comparar("totais", "Total de descontos", descontos, val("00106"), "Soma dos descontos do recibo.");
  if (tem("00110")) comparar("totais", "Líquido do 13º", proventos - descontos, val("00110"), "Proventos − descontos.");

  // --- Desligado recebendo a 1ª parcela --------------------------------------------------------
  if (tipo === "13_1" && categoria === "rescisao") {
    push({
      regra: "desligado",
      titulo: "Desligado na 1ª parcela",
      status: "erro",
      detalhe: `${f.situacao} — o 13º de quem foi desligado sai na rescisão, não na 1ª parcela.`,
    });
  }

  // --- Valor da parcela (salário ÷ 12 × avos) ------------------------------------------------
  if (parcela) {
    // A 1ª parcela usa o salário mensal do momento do cálculo (evento 00569); a 2ª, o salário atual.
    const salario = tipo === "13_1" ? val("00569") || f.salarioBase : f.salarioBase;
    const fator = tipo === "13_1" ? 0.5 : 1;
    comparar(
      "parcela",
      tipo === "13_1" ? "Adiantamento do 13º" : "13º salário",
      (salario * fator * avosArquivo) / 12,
      parcela.valor,
      `${tipo === "13_1" ? "50% de " : ""}salário ${fmt(salario)} ÷ 12 × ${avosArquivo} avo(s).`
    );
    if (maternidade) {
      comparar(
        "parcela",
        "13º da licença-maternidade",
        (salario * avosMaternidade) / 12,
        maternidade.valor,
        `Salário ${fmt(salario)} ÷ 12 × ${avosMaternidade} avo(s) de licença — pago pela empresa e compensado no INSS da empresa.`
      );
    }
    const codigoGrat = tipo === "13_1" ? "00750" : "00751";
    if (tem(codigoGrat)) {
      comparar("parcela", "Gratificação do 13º", parcela.valor * GRATIFICACAO, val(codigoGrat), `40% de ${fmt(parcela.valor)}.`);
    }
  }

  // --- Avos x histórico mensal ------------------------------------------------------------------
  if (parcela) {
    const calc = calcularAvos(f, ano, ctx);
    const faltando = calc.mesesSemFolha.filter((m) => m < (tipo === "13_1" ? 11 : 12));
    const explicacao = `Meses com 15 dias ou mais: ${calc.meses.join(", ") || "nenhum"} (${calc.avos} avo(s)).`;
    if (calc.avos === avosTotal) {
      push({ regra: "avos", titulo: "Avos", status: "ok", esperado: calc.avos, encontrado: avosTotal, detalhe: `${explicacao}${avosMaternidade ? ` Arquivo: ${textoAvosArquivo}.` : ""}` });
    } else if (tipo === "13_1" && categoria === "afastado" && calc.avos < avosArquivo) {
      push({
        regra: "avos",
        titulo: "Avos",
        status: "alerta",
        esperado: calc.avos,
        encontrado: avosArquivo,
        detalhe: `${explicacao} O adiantamento foi calculado com ${avosArquivo} avos, mas pelo afastamento (${f.situacao}) seriam ${calc.avos} — a 2ª parcela vai descontar o adiantamento maior.`,
      });
    } else if (faltando.length > 0) {
      push({
        regra: "avos",
        titulo: "Avos",
        status: "pendente",
        esperado: calc.avos,
        encontrado: avosTotal,
        detalhe: `${explicacao}${avosMaternidade ? ` Arquivo: ${textoAvosArquivo}.` : ""} Faltam as folhas de ${faltando.map((m) => NOMES_MES[m - 1]).join(", ")} para confirmar.`,
      });
    } else {
      push({ regra: "avos", titulo: "Avos", status: "erro", esperado: calc.avos, encontrado: avosTotal, detalhe: `${explicacao} O arquivo usou ${textoAvosArquivo}.` });
    }
  }

  // --- FGTS -------------------------------------------------------------------------------------
  const aliquotaFgts = aprendiz ? p.fgtsAprendiz : p.fgts;
  if (tem("00913")) {
    comparar("fgts", "FGTS do 13º", val("00915") * aliquotaFgts, val("00913"), `${aprendiz ? "2%" : "8%"} sobre a base ${fmt(val("00915"))}.`);
  }

  if (tipo === "13_1") {
    if (tem("00915")) comparar("fgts", "Base do FGTS", proventos, val("00915"), "Total pago na 1ª parcela.");
  } else {
    // --- Médias (só na 2ª parcela) ------------------------------------------------------------
    // Como o ERP: período de dezembro do ano anterior a novembro; as horas (HE, noturno e DSR sobre
    // noturno) somadas em quantidade e valorizadas pelo salário-hora ATUAL (Súmula 347 do TST); os
    // eventos em valor (DSR sobre HE, insalubridade, periculosidade) pelo valor pago; soma ÷ 12.
    const media = calcularMedia13(f, ano, ctx);
    const mediaErp = val("00918");
    const textoMedia =
      `Variáveis de ${media.periodo} (${fmt(media.somaPaga)} pagos` +
      (Math.abs(media.reajuste) >= 0.01 ? ` + ${fmt(media.reajuste)} de reajuste das horas pelo salário-hora atual ${fmt(media.horaAtual)}` : "") +
      `) = ${fmt(media.soma)} ÷ 12.`;
    if (mediaErp > 0 || media.media > 0.01) {
      const faltam = media.faltando.join(", ");
      if (media.faltando.length === 0 || Math.abs(media.media - mediaErp) <= 0.05) {
        comparar("medias", "Médias do 13º", media.media, mediaErp, textoMedia, 0.05);
      } else if (media.media > mediaErp + 0.05) {
        // Os meses que faltam só aumentariam a soma — então o arquivo já está abaixo do esperado.
        push({
          regra: "medias",
          titulo: "Médias do 13º",
          status: "alerta",
          esperado: arred(media.media),
          encontrado: arred(mediaErp),
          detalhe: `${textoMedia} Só com os meses já importados a média já passa do valor do arquivo (diferença de ${fmt(mediaErp - media.media)}) — conferir as variáveis consideradas pelo ERP.`,
        });
      } else {
        const precisa = mediaErp * 12 - media.soma;
        push({
          regra: "medias",
          titulo: "Médias do 13º",
          status: "pendente",
          esperado: arred(media.media),
          encontrado: arred(mediaErp),
          detalhe: `${textoMedia} Faltam as folhas de ${faltam}. Para o valor do arquivo (${fmt(mediaErp)}) fechar, esses meses precisam somar ${fmt(precisa)} em variáveis.`,
        });
      }
    }

    // --- INSS do 13º --------------------------------------------------------------------------
    const base = val("00012") + val("00432") + val("00751") + val("00918");
    if (tem("00094")) comparar("inss", "Base do INSS do 13º", base, val("00094"), `13º${tem("00432") ? " + 13º da licença-maternidade" : ""} + gratificação + médias.`);
    if (tem("00452") || tem("00094")) {
      comparar("inss", "INSS do 13º", calcularInss(val("00094"), p), val("00452"), `Tabela progressiva sobre ${fmt(val("00094"))}, separada do salário do mês.`);
    }

    // --- IR do 13º (tributação exclusiva; sem o mínimo de R$ 10 de retenção) --------------------
    if (tem("00097") || tem("00501")) {
      const deducoes = val("00452") + val("00800") + val("00551");
      const comDeducoes = val("00094") - deducoes;
      const simplificado = val("00094") - p.irDescontoSimplificado;
      const baseIr = Math.max(0, Math.min(comDeducoes, simplificado));
      comparar(
        "ir",
        "Base do IR do 13º",
        baseIr,
        val("00097"),
        `Menor entre ${fmt(comDeducoes)} (13º − INSS − dependentes − pensão) e ${fmt(simplificado)} (desconto simplificado de ${fmt(p.irDescontoSimplificado)}).`
      );
      comparar(
        "ir",
        "IR do 13º",
        calcularIr(val("00097"), val("00094"), { ...p, irMinimoRetencao: 0 }),
        val("00501"),
        `Tabela sobre a base ${fmt(val("00097"))}, com o redutor sobre o 13º bruto de ${fmt(val("00094"))}. No 13º não há o mínimo de R$ 10.`,
        0.05
      );
    }

    // --- Pensão alimentícia sobre o 13º (conforme o cadastro da aba Pensões) ------------------------
    if (ctx.pensoes !== undefined) {
      const pensao = conferirPensao13(f, ctx.pensoes?.get(f.matricula), p.salarioMinimo);
      if (pensao) push(pensao);
    }

    // --- Desconto da 1ª parcela ----------------------------------------------------------------
    const descontoAdiant = val("00460");
    const um = ctx.primeiraParcela?.get(f.matricula);
    if (ctx.primeiraParcela) {
      const pago = um ? val0(um, "00069") + val0(um, "00750") : 0;
      if (um || descontoAdiant) {
        comparar("adiantamento", "Desconto da 1ª parcela", pago, descontoAdiant, um ? `Pago na 1ª parcela: ${fmt(pago)}.` : "Não consta na 1ª parcela importada.");
      }
      if (um) {
        const avos1 = um.eventos.find((e) => e.codigo === "00069")?.referencia ?? 0;
        if (avos1 && avos1 !== avosTotal) {
          push({
            regra: "adiantamento",
            titulo: "Avos da 1ª x 2ª parcela",
            status: "alerta",
            esperado: avosTotal,
            encontrado: avos1,
            detalhe: `A 1ª parcela usou ${avos1} avos e a 2ª usou ${textoAvosArquivo}${/^Afastado/i.test(f.situacao) ? ` (${f.situacao})` : ""}.`,
          });
        }
      }
    } else if (descontoAdiant) {
      push({ regra: "adiantamento", titulo: "Desconto da 1ª parcela", status: "pendente", encontrado: descontoAdiant, detalhe: "A 1ª parcela deste ano ainda não foi importada." });
    }

    // Adiantamento pago nas férias (00034 nas folhas mensais) descontado aqui como 00663.
    const adiantFerias = (ctx.historico.get(f.matricula) ?? []).reduce(
      (a, m) => a + m.eventos.filter((e) => e.codigo === "00034").reduce((b, e) => b + e.valor, 0),
      0
    );
    if (tem("00663") || adiantFerias > 0) {
      const encontrado = val("00663");
      const faltando = [...Array(12).keys()].map((i) => i + 1).filter((m) => !ctx.mesesImportados.has(m) && m <= 11);
      if (Math.abs(adiantFerias - encontrado) <= TOLERANCIA || faltando.length === 0) {
        comparar("adiantamento", "Adiantamento pago nas férias", adiantFerias, encontrado, `Soma do adiantamento do 13º pago nas férias nas folhas do ano: ${fmt(adiantFerias)}.`);
      } else {
        push({
          regra: "adiantamento",
          titulo: "Adiantamento pago nas férias",
          status: "pendente",
          esperado: arred(adiantFerias),
          encontrado,
          detalhe: `Nas folhas importadas o adiantamento pago nas férias soma ${fmt(adiantFerias)}; faltam as folhas de ${faltando.map((m) => NOMES_MES[m - 1]).join(", ")}.`,
        });
      }
    }

    // Recebeu o 13º inteiro sem nenhum adiantamento.
    if (ctx.primeiraParcela && !um && !descontoAdiant && !tem("00663") && parcela) {
      push({
        regra: "adiantamento",
        titulo: "Sem 1ª parcela",
        status: "alerta",
        detalhe: "Não recebeu a 1ª parcela (nem adiantamento nas férias) — confirmar se ficou de fora do adiantamento.",
      });
    }

    // Base do FGTS da 2ª = 13º total menos o que já teve FGTS (1ª parcela e adiantamento nas férias).
    if (tem("00915")) {
      comparar("fgts", "Base do FGTS", val("00094") - descontoAdiant - val("00663"), val("00915"), "13º total − 1ª parcela − adiantamento nas férias (que já tiveram FGTS).", 0.03);
    }
  }

  return {
    matricula: f.matricula,
    nome: f.nome,
    funcao: f.funcao,
    situacao: f.situacao,
    categoria,
    salarioBase: f.salarioBase,
    proventos: arred(proventos),
    descontos: arred(descontos),
    liquido: arred(tem("00110") ? val("00110") : proventos - descontos),
    fgts: arred(val("00913")),
    inss: arred(val("00452")),
    ir: arred(val("00501")),
    consignado: 0,
    divisorHoras: null,
    criticas,
    status: piorStatus(criticas),
  };
}

function val0(f: FuncionarioFolha, codigo: string) {
  return f.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + e.valor, 0);
}

export function conferirFolha13(funcionarios: FuncionarioFolha[], competencia: string, tipo: "13_1" | "13_2", ctx: Contexto13) {
  const ano = Number(competencia.split("/")[1]);
  const { parametros, exato } = parametrosDoAno(ano);
  const resultados = funcionarios.map((f) => conferirFuncionario13(f, tipo, ano, ctx, parametros));
  return { resultados, anoParametros: parametros.ano, parametrosExatos: exato };
}
