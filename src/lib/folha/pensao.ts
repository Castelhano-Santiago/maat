// Pensão alimentícia: conferência do desconto da folha contra o cadastro feito pelo DP (aba Pensões
// da Análise da Folha), conforme a modalidade da decisão judicial.
//   - % do salário mínimo: percentual × mínimo do ano (o mesmo valor todo mês; no 13º, mais uma parcela).
//   - % dos rendimentos líquidos: percentual × (todos os proventos − INSS − IR), com pensão e IR em
//     looping. Até out/2026 o ERP deixava a hora extra 100% (00363) e as diferenças de dissídio
//     (00413/00668) fora da base; a Praxio corrigiu a parametrização em 23/11/2026 (retroativo não
//     corrigido, por decisão do DP).
//   - valor fixo em reais.
// Um colaborador pode ter mais de uma pensão (ex.: VPar 010004 — 30% do líquido + 50% do mínimo): o
// ERP soma todas no mesmo evento, e a conferência compara com a soma.
// Eventos: 00469 (salário), 00470 (recibo de férias), 00551 (13º).

import type { FuncionarioFolha } from "../parsers/folha-pagamento";
import type { Critica, ResultadoFuncionario } from "./conferencia";

export type ModalidadePensao = "salario_minimo" | "liquido" | "fixo";

export type CadastroPensao = {
  modalidade: ModalidadePensao;
  percentual: number | null;
  valorFixo: number | null;
  incide13: boolean;
  incideFerias: boolean;
};

// Pensões de cada matrícula (uma ou mais).
export type CadastroPensoes = Map<string, CadastroPensao[]>;

export const ROTULO_MODALIDADE: Record<ModalidadePensao, string> = {
  salario_minimo: "% do salário mínimo",
  liquido: "% dos rendimentos líquidos",
  fixo: "Valor fixo",
};

type IrDoMes = { calcular: (baseIr: number, bruto: number) => number; descontoSimplificado: number };

const TOLERANCIA = 0.1;
const arred = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const perto = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA;

function piorStatus(criticas: Critica[]): ResultadoFuncionario["status"] {
  const ordem: Record<string, number> = { erro: 3, alerta: 2, pendente: 1, ok: 0 };
  return criticas.reduce<ResultadoFuncionario["status"]>(
    (pior, c) => (c.status !== "info" && ordem[c.status] > ordem[pior] ? c.status : pior),
    "ok"
  );
}

export function descreverCadastro(c: CadastroPensao, salarioMinimo: number): string {
  if (c.modalidade === "fixo") return `valor fixo de ${fmt(c.valorFixo ?? 0)}`;
  if (c.modalidade === "salario_minimo")
    return `${fmt(c.percentual ?? 0)}% do salário mínimo (${fmt(salarioMinimo)}) = ${fmt(((c.percentual ?? 0) / 100) * salarioMinimo)}`;
  return `${fmt(c.percentual ?? 0)}% dos rendimentos líquidos`;
}

const descreverTodas = (lista: CadastroPensao[], salarioMinimo: number) =>
  lista.map((c) => descreverCadastro(c, salarioMinimo)).join(" + ");

// Valor de uma pensão que não depende do salário do mês (% do mínimo ou valor fixo).
const valorFixoDa = (c: CadastroPensao, salarioMinimo: number) =>
  c.modalidade === "fixo" ? c.valorFixo ?? 0 : c.modalidade === "salario_minimo" ? ((c.percentual ?? 0) / 100) * salarioMinimo : 0;

// Folha mensal: 00469 (salário) + 00470 (férias).
export function conferirPensaoMensal(
  f: FuncionarioFolha,
  resultado: ResultadoFuncionario,
  cadastros: CadastroPensao[] | undefined,
  salarioMinimo: number,
  // IR do salário do mês (tabela de quando a folha é paga), para o looping da pensão sobre o líquido.
  ir?: IrDoMes
): ResultadoFuncionario {
  const val = (codigo: string) => f.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + e.valor, 0);
  const ref = (codigo: string) => f.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + (e.referencia ?? 0), 0);
  const salario = val("00469");
  const ferias = val("00470");
  const total = salario + ferias;
  const titulo = "Pensão alimentícia";
  const lista = cadastros ?? [];
  let critica: Critica | null = null;
  const desc = descreverTodas(lista, salarioMinimo);
  const parteFixa = lista.reduce((a, c) => a + valorFixoDa(c, salarioMinimo), 0);
  const pctLiquido = lista.filter((c) => c.modalidade === "liquido").reduce((a, c) => a + (c.percentual ?? 0), 0) / 100;
  const textoFixa = parteFixa && pctLiquido ? `${fmt(parteFixa)} + ` : "";

  if (lista.length === 0) {
    if (total > 0) {
      critica = {
        regra: "pensao",
        titulo,
        status: "pendente",
        encontrado: arred(total),
        detalhe: `Desconto de pensão de ${fmt(total)}${ferias ? ` (salário ${fmt(salario)} + férias ${fmt(ferias)})` : ""} sem cadastro — cadastre a modalidade da decisão na aba Pensões.`,
      };
    }
  } else if (total === 0) {
    // Sem remuneração no mês (afastado pelo INSS, rescisão sem saldo) não há de onde descontar.
    const proventos = f.eventos.filter((e) => e.coluna === "provento").reduce((a, e) => a + e.valor, 0);
    if (proventos > 0 && resultado.categoria !== "afastado") {
      critica = { regra: "pensao", titulo, status: "alerta", encontrado: 0, detalhe: `Pensão cadastrada (${desc}), mas não houve desconto neste mês.` };
    }
  } else if (ferias > 0 && !lista.some((c) => c.incideFerias)) {
    critica = {
      regra: "pensao",
      titulo,
      status: "alerta",
      encontrado: arred(ferias),
      detalhe: `Pensão descontada nas férias (${fmt(ferias)}), mas o cadastro diz que ela não incide sobre férias — conferir a decisão.`,
    };
  } else if (pctLiquido === 0) {
    // Só % do mínimo e/ou valor fixo.
    const diasSalario = ref("00001");
    const proporcional = diasSalario > 0 && diasSalario < 30 ? (parteFixa * diasSalario) / 30 : null;
    if (perto(total, parteFixa)) {
      critica = { regra: "pensao", titulo, status: "ok", esperado: arred(parteFixa), encontrado: arred(total), detalhe: `${desc}.` };
    } else if (proporcional !== null && (perto(salario, proporcional) || perto(total, proporcional))) {
      critica = {
        regra: "pensao",
        titulo,
        status: "ok",
        esperado: arred(proporcional),
        encontrado: arred(salario),
        detalhe: `${desc}, proporcional a ${diasSalario} dia(s) de salário = ${fmt(proporcional)}${ferias ? `; nas férias ${fmt(ferias)}` : ""}.`,
      };
    } else {
      critica = {
        regra: "pensao",
        titulo,
        status: ferias > 0 ? "pendente" : "alerta",
        esperado: arred(parteFixa),
        encontrado: arred(total),
        detalhe:
          ferias > 0
            ? `${desc}. Mês com férias: salário ${fmt(salario)} + férias ${fmt(ferias)} — conferir a divisão no recibo de férias.`
            : `${desc}. Diferença de ${fmt(total - parteFixa)}.`,
      };
    }
  } else {
    // Com pensão sobre os rendimentos líquidos: todos os proventos (tributáveis ou não — ex.:
    // comissão adicional 00227, abono pecuniário) − INSS − IR. Como a pensão é dedutível do IR e o IR
    // reduz o líquido, pensão e IR são calculados juntos em looping até estabilizar (o ERP faz o mesmo).
    // As pensões fixas (% do mínimo, valor fixo) entram somadas e também deduzem do IR.
    const proventos = f.eventos.filter((e) => e.coluna === "provento").reduce((a, e) => a + e.valor, 0);
    const inss = val("00451") + val("00500");
    const irFolha = val("00453") + val("00481");
    const he100 = val("00363");
    const bruto = val("00096");

    if (ferias > 0 || !ir || bruto <= 0) {
      // Mês com férias (pensão dividida entre salário e recibo de férias) ou sem a base do IR:
      // compara com o IR que veio na folha, sem looping.
      const base = proventos - inss - irFolha;
      const esperado = parteFixa + pctLiquido * base;
      const conta = `${desc}: ${textoFixa}(proventos ${fmt(proventos)} − INSS ${fmt(inss)} − IR ${fmt(irFolha)}) = ${fmt(base)} × ${fmt(pctLiquido * 100)}%`;
      critica = perto(total, esperado)
        ? { regra: "pensao", titulo, status: "ok", esperado: arred(esperado), encontrado: arred(total), detalhe: `${conta} = ${fmt(esperado)}.` }
        : {
            regra: "pensao",
            titulo,
            status: ferias > 0 ? "pendente" : "alerta",
            esperado: arred(esperado),
            encontrado: arred(total),
            detalhe: `${conta} = ${fmt(esperado)}. Diferença de ${fmt(total - esperado)}${ferias > 0 ? " — mês com férias, conferir a divisão no recibo de férias" : ""}.`,
          };
    } else {
      const deducoes = val("00451") + val("00800");
      const looping = (excluir: number) => {
        let pensao = 0;
        let imposto = 0;
        const voltas: number[] = [];
        for (let i = 0; i < 50; i++) {
          const baseIr = Math.max(0, Math.min(bruto - deducoes - pensao, bruto - ir.descontoSimplificado));
          imposto = ir.calcular(baseIr, bruto);
          const nova = arred(parteFixa + pctLiquido * (proventos - inss - imposto - excluir));
          voltas.push(nova);
          if (Math.abs(nova - pensao) < 0.005) break;
          pensao = nova;
        }
        return { pensao, imposto, voltas };
      };
      const certo = looping(0);
      const liquido = proventos - inss - certo.imposto;
      const conta =
        `${desc}: pensão e IR em looping (${certo.voltas.length} volta(s): ${certo.voltas.map(fmt).join(" → ")}) — ` +
        `${textoFixa}(proventos ${fmt(proventos)} − INSS ${fmt(inss)} − IR ${fmt(certo.imposto)}) = ${fmt(liquido)} × ${fmt(pctLiquido * 100)}% = ${fmt(certo.pensao)}`;
      if (perto(total, certo.pensao)) {
        critica = { regra: "pensao", titulo, status: "ok", esperado: certo.pensao, encontrado: arred(total), detalhe: `${conta}.` };
      } else {
        const semHe100 = he100 ? looping(he100) : null;
        const foiSemHe100 = semHe100 !== null && perto(total, semHe100.pensao);
        critica = {
          regra: "pensao",
          titulo,
          status: "alerta",
          esperado: certo.pensao,
          encontrado: arred(total),
          detalhe: foiSemHe100
            ? `${conta}. O ERP descontou ${fmt(total)}: deixou a hora extra 100% (${fmt(he100)}) fora da base — faltaram ${fmt(certo.pensao - total)} para o beneficiário${Math.abs(certo.imposto - irFolha) >= 0.01 ? ` (e o IR ficaria ${fmt(certo.imposto)} em vez de ${fmt(irFolha)})` : ""}. A Praxio incluiu a HE 100% e as diferenças de dissídio na base em 23/11/2026 — em folhas anteriores é a diferença já conhecida (retroativo não corrigido); a partir de 11/2026, conferir a parametrização.`
            : `${conta}. Diferença de ${fmt(total - certo.pensao)}.`,
        };
      }
    }
  }

  if (!critica) return resultado;
  const criticas = [...resultado.criticas, critica];
  return { ...resultado, criticas, status: piorStatus(criticas) };
}

// 13º salário (2ª parcela): 00551.
export function conferirPensao13(f: FuncionarioFolha, cadastros: CadastroPensao[] | undefined, salarioMinimo: number): Critica | null {
  const val = (codigo: string) => f.eventos.filter((e) => e.codigo === codigo).reduce((a, e) => a + e.valor, 0);
  const pensao = f.eventos.find((e) => e.codigo === "00551");
  const descontado = val("00551");
  const titulo = "Pensão alimentícia";
  const liquido13 = val("00094") - val("00452") - val("00501");
  const lista = cadastros ?? [];

  if (lista.length === 0) {
    if (!pensao) return null;
    const pct = pensao.referencia && pensao.referencia <= 100 ? pensao.referencia : null;
    const dica =
      pct && perto(descontado, (pct / 100) * salarioMinimo)
        ? ` O valor bate com ${fmt(pct)}% do salário mínimo.`
        : pct && perto(descontado, (pct / 100) * liquido13)
          ? ` O valor bate com ${fmt(pct)}% do 13º líquido.`
          : "";
    return {
      regra: "pensao",
      titulo,
      status: "pendente",
      encontrado: arred(descontado),
      detalhe: `Desconto de pensão de ${fmt(descontado)} sem cadastro — cadastre a modalidade da decisão na aba Pensões.${dica}`,
    };
  }

  const noTreze = lista.filter((c) => c.incide13);
  const fora = lista.filter((c) => !c.incide13);
  const textoFora = fora.length ? ` Sem incidência no 13º pelo cadastro: ${descreverTodas(fora, salarioMinimo)}.` : "";
  if (noTreze.length === 0) {
    return descontado > 0
      ? { regra: "pensao", titulo, status: "alerta", esperado: 0, encontrado: arred(descontado), detalhe: `${descreverTodas(lista, salarioMinimo)}, sem incidência no 13º pelo cadastro — mas o ERP descontou ${fmt(descontado)}. Conferir a decisão.` }
      : { regra: "pensao", titulo, status: "ok", esperado: 0, encontrado: 0, detalhe: `${descreverTodas(lista, salarioMinimo)}; não incide sobre o 13º.` };
  }

  const partes = noTreze.map((c) => {
    if (c.modalidade === "liquido") {
      const valor = ((c.percentual ?? 0) / 100) * liquido13;
      return { valor, texto: `${fmt(c.percentual ?? 0)}% de (13º ${fmt(val("00094"))} − INSS ${fmt(val("00452"))} − IR ${fmt(val("00501"))}) = ${fmt(valor)}` };
    }
    const valor = valorFixoDa(c, salarioMinimo);
    return { valor, texto: `${descreverCadastro(c, salarioMinimo)} (uma parcela no 13º)` };
  });
  const esperado = partes.reduce((a, p) => a + p.valor, 0);
  const conta = partes.map((p) => p.texto).join(" + ");
  if (perto(descontado, esperado)) {
    return { regra: "pensao", titulo, status: "ok", esperado: arred(esperado), encontrado: arred(descontado), detalhe: `${conta}.${textoFora}` };
  }
  return {
    regra: "pensao",
    titulo,
    status: descontado === 0 ? "alerta" : "erro",
    esperado: arred(esperado),
    encontrado: arred(descontado),
    detalhe:
      descontado === 0
        ? `${conta} = ${fmt(esperado)}, mas não houve desconto de pensão no 13º.${textoFora}`
        : `${conta} = ${fmt(esperado)}. Diferença de ${fmt(descontado - esperado)}.${textoFora}`,
  };
}
