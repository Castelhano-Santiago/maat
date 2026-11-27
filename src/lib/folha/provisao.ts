// Provisão da folha para o caixa/financeiro: prévia dos valores da próxima folha mensal e da 2ª parcela
// do 13º, a partir das folhas já importadas. Cálculo por colaborador (INSS, IR e pensão dependem de
// cada um), apresentado em totais por área (1º bloco da Divisão) e por guia.
//
// Folha mensal (competência C), para cada colaborador da última folha importada antes de C:
//   - salário cheio do mês (salário-base atual);
//   - variáveis e adicionais (HE, noturno, DSR, comissão, insalubridade...): média das últimas 3 folhas;
//   - férias do mês pela programação: o 1/3 sobre os dias de gozo e o abono pecuniário (o salário dos
//     dias de férias já está no salário cheio);
//   - afastados pelo INSS sem salário; desligados fora; admitidos depois da última folha com salário
//     proporcional;
//   - INSS e IR pelas tabelas (IR da folha de dezembro pela tabela do ano seguinte), pensão pelo
//     cadastro (com looping pensão × IR), e-consignado e outros descontos pela última folha / média.
// 13º 2ª parcela: salário × avos + médias (dez a nov, novembro estimado pela média de 3 meses
//   quando ainda não importado) − 1ª parcela − INSS − IR − pensão — as mesmas regras da conferência.

import type { FuncionarioFolha } from "../parsers/folha-pagamento";
import { calcularInss, calcularIr, calendarioCompetencia, feriadosDoMes } from "./conferencia";
import { calcularAvos, calcularMedia13, EVENTOS_MEDIA, type Contexto13 } from "./conferencia-13";
import type { ProgramacaoFerias } from "./ferias-programacao";
import { parametrosDoAno, type ParametrosFolha } from "./parametros";
import type { CadastroPensao, CadastroPensoes } from "./pensao";

export type AliquotasProvisao = {
  patronal: number; // % sobre a base INSS da empresa
  cprbReceita: number; // % sobre a receita
  terceiros: number;
  rat: number | null; // null = ainda não informado
};

export type ValoresProvisao = {
  areas: { area: string; valor: number; colaboradores: number }[];
  liquido: number;
  // Líquido das rescisões (termo de rescisão, com prévia própria do DP — fica fora da provisão, só no aviso).
  // Opcional: provisões registradas antes de 27/11/2026 não têm o campo.
  rescisoes?: number;
  pensoes: number;
  fgts: number;
  consignado: number;
  baseInssEmpresa: number;
  inssEmpresa: number; // patronal + terceiros + RAT sobre a folha
  cprb: number; // % sobre a receita
  inssFuncionarios: number;
  irFuncionarios: number;
  colaboradores: number;
};

// Áreas pelo 1º bloco da Divisão da folha ("0008.0029.0075.0001" → Adm - Operação).
const AREAS: Record<string, string> = { "0001": "Manutenção", "0003": "Administrativo", "0008": "Adm - Operação", "0011": "Operação" };
export const ORDEM_AREAS = ["Manutenção", "Administrativo", "Adm - Operação", "Operação"];
export function areaDaDivisao(divisao: string | null | undefined): string {
  const bloco = (divisao ?? "").split(".")[0];
  return AREAS[bloco] ?? (bloco ? `Divisão ${bloco}` : "Sem divisão");
}

// Eventos que não entram na média de variáveis: dias de salário, férias, rescisão, 13º, verbas
// eventuais (diferença de dissídio) e pares que se anulam (condução, devolução do e-consignado).
const FORA_DA_MEDIA = new Set([
  "00001", "00752", "00188", "00116",
  "00007", "00021", "00084", "00085", "00013", "00146", "00147", "00358", "00213", "00214", "00215", "00216",
  "00024", "00014", "00009", "00433", "00434", "00626", "00761", "00760", "00031",
  "00034", "00413", "00668", "00056", "15577",
]);
// Proventos que não entram na base do INSS/FGTS/IR (comissão adicional, abono pecuniário).
const FORA_DA_BASE = new Set(["00227", "00213", "00214", "00215", "00216"]);
// Descontos tratados à parte (legais, pensão, consignado) ou que não se repetem.
const DESCONTOS_A_PARTE = new Set(["00451", "00500", "00453", "00481", "00469", "00470", "00459", "00700", "00452", "00498", "15576", "00515"]);
const ehConsignado = (codigo: string) => /^020\d\d$/.test(codigo);

const arred = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const soma = (f: FuncionarioFolha, filtro: (codigo: string, coluna: string) => boolean) =>
  f.eventos.filter((e) => filtro(e.codigo, e.coluna)).reduce((a, e) => a + e.valor, 0);
const val = (f: FuncionarioFolha, codigo: string) => soma(f, (c) => c === codigo);
const ehAprendiz = (funcao: string) => /APRENDIZ/i.test(funcao);
const moedaTexto = (v: number) => arred(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Último dia da frequência apurada na folha prévia do ERP (o restante do mês entra no fechamento).
const DIA_CORTE_FREQUENCIA = 25;
// Desligado com termo de rescisão na folha: sem líquido de folha (00996) — o valor é pago à parte.
const ehRescisao = (f: FuncionarioFolha) => /^Desligado/i.test(f.situacao) && !f.eventos.some((e) => e.codigo === "00996");

function vazio(): ValoresProvisao {
  return { areas: [], liquido: 0, rescisoes: 0, pensoes: 0, fgts: 0, consignado: 0, baseInssEmpresa: 0, inssEmpresa: 0, cprb: 0, inssFuncionarios: 0, irFuncionarios: 0, colaboradores: 0 };
}

function fecharAreas(porArea: Map<string, { valor: number; colaboradores: number }>) {
  return [...porArea.entries()]
    .map(([area, v]) => ({ area, valor: arred(v.valor), colaboradores: v.colaboradores }))
    .sort((a, b) => {
      const ia = ORDEM_AREAS.indexOf(a.area);
      const ib = ORDEM_AREAS.indexOf(b.area);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.area.localeCompare(b.area);
    });
}

function encargosEmpresa(v: ValoresProvisao, aliq: AliquotasProvisao, receita: number | null, comCprb: boolean) {
  v.inssEmpresa = arred((v.baseInssEmpresa * (aliq.patronal + aliq.terceiros + (aliq.rat ?? 0))) / 100);
  v.cprb = comCprb && receita ? arred((receita * aliq.cprbReceita) / 100) : 0;
}

// Pensão do mês com looping pensão × IR (mesma regra da conferência). Pensões fixas (% do mínimo,
// valor fixo) somadas à parte sobre o líquido.
function pensaoEIr(
  cadastros: CadastroPensao[],
  proventos: number,
  baseIr: number,
  inss: number,
  dependentes: number,
  p: ParametrosFolha,
  irMinimo = true
) {
  const pIr = irMinimo ? p : { ...p, irMinimoRetencao: 0 };
  const fixa = cadastros
    .filter((c) => c.modalidade !== "liquido")
    .reduce((a, c) => a + (c.modalidade === "fixo" ? c.valorFixo ?? 0 : ((c.percentual ?? 0) / 100) * p.salarioMinimo), 0);
  const pct = cadastros.filter((c) => c.modalidade === "liquido").reduce((a, c) => a + (c.percentual ?? 0), 0) / 100;
  let pensao = 0;
  let ir = 0;
  for (let i = 0; i < 50; i++) {
    const base = Math.max(0, Math.min(baseIr - inss - dependentes - pensao, baseIr - p.irDescontoSimplificado));
    ir = calcularIr(base, baseIr, pIr);
    const nova = arred(fixa + pct * (proventos - inss - ir));
    if (Math.abs(nova - pensao) < 0.005) break;
    pensao = nova;
  }
  return { pensao: cadastros.length ? pensao : 0, ir };
}

const diaMs = 86_400_000;
const isoParaUtc = (s: string) => {
  const [a, m, d] = s.slice(0, 10).split("-").map(Number);
  return Date.UTC(a, m - 1, d);
};

// ---------------------------------------------------------------------------------------------------
// Folha mensal

export type EntradaMensal = {
  competencia: string; // "MM/AAAA" a provisionar
  base: FuncionarioFolha[]; // última folha mensal importada antes da competência
  ultimas: FuncionarioFolha[][]; // até 3 últimas folhas (inclui a base), para as médias
  programacao: ProgramacaoFerias | null;
  admitidos: { matricula: string; nome: string; funcao: string; salario: number; admissao: string }[]; // ISO
  desligados: Set<string>;
  pensoes: CadastroPensoes;
  aliquotas: AliquotasProvisao;
  receita: number | null;
  // Parcelas do arquivo do e-Consignado da competência, por matrícula (quando já importado); sem ele,
  // repete o desconto da última folha.
  consignadoArquivo: Map<string, number> | null;
};

export function provisionarMensal(e: EntradaMensal): ValoresProvisao & { avisos: string[] } {
  const [mes, ano] = e.competencia.split("/").map(Number);
  const pDoAno = parametrosDoAno(ano).parametros;
  const p = mes === 12 ? { ...pDoAno, ...pIrDe(parametrosDoAno(ano + 1).parametros) } : pDoAno;
  const inicioMes = Date.UTC(ano, mes - 1, 1);
  const fimMes = Date.UTC(ano, mes, 0);
  const diasMes = new Date(fimMes).getUTCDate();
  const v = vazio();
  const porArea = new Map<string, { valor: number; colaboradores: number }>();
  const avisos: string[] = [];
  let afastados = 0;
  let saidas = 0;

  const historico = new Map<string, FuncionarioFolha[]>();
  for (const folha of e.ultimas) for (const f of folha) historico.set(f.matricula, [...(historico.get(f.matricula) ?? []), f]);

  const acumular = (area: string, liquido: number) => {
    const reg = porArea.get(area) ?? { valor: 0, colaboradores: 0 };
    reg.valor += liquido;
    reg.colaboradores++;
    porArea.set(area, reg);
  };

  for (const f of e.base) {
    if (/^Desligado/i.test(f.situacao) || e.desligados.has(f.matricula)) {
      saidas++;
      continue;
    }
    if (/^Afastado/i.test(f.situacao) && !/MATERNIDADE/i.test(f.situacao)) {
      afastados++;
      continue;
    }
    const meses = historico.get(f.matricula) ?? [f];
    const media = (filtro: (codigo: string, coluna: string) => boolean) => meses.reduce((a, m) => a + soma(m, filtro), 0) / meses.length;
    const salario = f.salarioBase;
    const variaveis = media((c, col) => col === "provento" && !FORA_DA_MEDIA.has(c));
    const variaveisForaBase = media((c, col) => col === "provento" && !FORA_DA_MEDIA.has(c) && FORA_DA_BASE.has(c));

    // Férias do mês: 1/3 sobre os dias de gozo + abono pecuniário (quando o gozo começa no mês). O
    // recibo de férias paga o gozo inteiro com antecedência (inclusive os dias do mês seguinte), e o
    // FGTS incide sobre o recibo todo.
    let terco = 0;
    let abono = 0;
    let feriasAdiantadas = 0;
    for (const per of e.programacao?.get(f.matricula) ?? []) {
      if (!per.gozoInicio || !per.gozoFim) continue;
      const ini = Math.max(isoParaUtc(per.gozoInicio), inicioMes);
      const fim = Math.min(isoParaUtc(per.gozoFim), fimMes);
      if (fim < ini) continue;
      const dias = Math.round((fim - ini) / diaMs) + 1;
      const diaria = (salario + variaveis) / 30;
      terco += (diaria * dias) / 3;
      const comecaNoMes = isoParaUtc(per.gozoInicio) >= inicioMes && isoParaUtc(per.gozoInicio) <= fimMes;
      if (comecaNoMes && per.diasAbono) abono += diaria * per.diasAbono * (4 / 3);
      if (comecaNoMes) {
        const diasTotal = Math.round((isoParaUtc(per.gozoFim) - isoParaUtc(per.gozoInicio)) / diaMs) + 1;
        feriasAdiantadas += diaria * Math.max(0, diasTotal - dias) * (4 / 3);
      }
    }

    const proventos = salario + variaveis + terco + abono;
    const baseInss = proventos - variaveisForaBase - abono;
    // INSS: o maior entre o calculado sobre a projeção e a média descontada nas últimas folhas (a
    // média traz o INSS dos recibos de férias, que pagam o gozo inteiro com antecedência).
    const inss = Math.max(calcularInss(baseInss, p), media((c) => c === "00451" || c === "00500"));
    const dependentes = val(f, "00800");
    const cadastros = e.pensoes.get(f.matricula) ?? [];
    const { pensao: pensaoCadastro, ir: irCalculado } = pensaoEIr(cadastros, proventos, baseInss, inss, dependentes, p);
    const pensao = cadastros.length ? pensaoCadastro : val(f, "00469");
    // IR: com a isenção até R$ 5.000 (redutor), o imposto muda bruscamente perto desse valor — o IR
    // calculado sobre a média das variáveis zera quem oscila em torno dos 5 mil. Usa a média do IR
    // retido nas últimas folhas (salário + férias); só quem tem pensão sobre o líquido fica com o
    // IR do looping.
    const temPensaoLiquido = cadastros.some((c) => c.modalidade === "liquido");
    const ir = temPensaoLiquido ? irCalculado : media((c) => c === "00453" || c === "00481");
    const consignado = e.consignadoArquivo
      ? Math.min(e.consignadoArquivo.get(f.matricula) ?? 0, Math.max(0, (proventos - inss - irCalculado - pensao) * p.limiteConsignado))
      : soma(f, (c, col) => col === "desconto" && ehConsignado(c));
    const outros = media((c, col) => col === "desconto" && !DESCONTOS_A_PARTE.has(c) && !ehConsignado(c));
    const liquido = Math.max(0, proventos - inss - ir - pensao - consignado - outros);

    acumular(areaDaDivisao(f.divisao), liquido);
    v.liquido += liquido;
    v.pensoes += pensao;
    v.consignado += consignado;
    v.inssFuncionarios += inss;
    v.irFuncionarios += ir;
    v.fgts += (baseInss + feriasAdiantadas) * (ehAprendiz(f.funcao) ? p.fgtsAprendiz : p.fgts);
    v.baseInssEmpresa += baseInss;
    v.colaboradores++;
  }

  // Admitidos depois da última folha importada: salário proporcional aos dias do mês.
  for (const a of e.admitidos) {
    const adm = isoParaUtc(a.admissao);
    if (adm > fimMes) continue;
    const dias = adm < inicioMes ? 30 : Math.min(30, diasMes - new Date(adm).getUTCDate() + 1);
    const proventos = (a.salario * dias) / 30;
    const inss = calcularInss(proventos, p);
    const ir = calcularIr(Math.max(0, Math.min(proventos - inss, proventos - p.irDescontoSimplificado)), proventos, p);
    const liquido = proventos - inss - ir;
    acumular("Novos admitidos", liquido);
    v.liquido += liquido;
    v.inssFuncionarios += inss;
    v.irFuncionarios += ir;
    v.fgts += proventos * (ehAprendiz(a.funcao) ? p.fgtsAprendiz : p.fgts);
    v.baseInssEmpresa += proventos;
    v.colaboradores++;
  }

  if (afastados) avisos.push(`${afastados} afastado(s) pelo INSS sem salário na projeção.`);
  if (saidas) avisos.push(`${saidas} desligado(s) fora da projeção (a rescisão não entra na provisão).`);
  avisos.push(
    e.consignadoArquivo
      ? "E-consignado pelo arquivo do e-Consignado da competência (limitado a 35% da remuneração líquida)."
      : "E-consignado igual ao desconto da última folha (o arquivo do e-Consignado da competência ainda não foi importado)."
  );
  if (e.admitidos.length) avisos.push(`${e.admitidos.length} admitido(s) depois da última folha, com salário proporcional e sem variáveis.`);

  v.areas = fecharAreas(porArea);
  encargosEmpresa(v, e.aliquotas, e.receita, true);
  return { ...arredondar(v), avisos };
}

// Folha mensal a partir da folha prévia do ERP (calculada antes do fechamento da frequência, por
// volta do dia 27): quem entra, salário, férias, afastamentos, pensões, consignado e descontos vêm da
// própria prévia. A frequência (período de 1 ao fim do mês) só está apurada até o dia 25: as horas
// da prévia (HE, noturno) são projetadas pelos dias úteis que faltam, colaborador a colaborador, e a
// comissão que só entra no fechamento vale a média das 3 últimas folhas (DP, 27/11/2026 — a média
// das variáveis inflava a provisão). Sobre o acréscimo, recalcula INSS, IR (o maior entre o da
// prévia e a média retida), pensão e FGTS.
export type EntradaPrevia = {
  competencia: string;
  previa: FuncionarioFolha[];
  ultimas: FuncionarioFolha[][]; // até 3 folhas anteriores à competência
  pensoes: CadastroPensoes;
  aliquotas: AliquotasProvisao;
  receita: number | null;
};

export function provisionarComPrevia(e: EntradaPrevia): ValoresProvisao & { avisos: string[]; acrescimoVariaveis: number; completados: number } {
  const [mes, ano] = e.competencia.split("/").map(Number);
  const pDoAno = parametrosDoAno(ano).parametros;
  const p = mes === 12 ? { ...pDoAno, ...pIrDe(parametrosDoAno(ano + 1).parametros) } : pDoAno;
  const v = vazio();
  const porArea = new Map<string, { valor: number; colaboradores: number }>();
  let acrescimoVariaveis = 0;
  let completados = 0;

  const historico = new Map<string, FuncionarioFolha[]>();
  for (const folha of e.ultimas) for (const f of folha) historico.set(f.matricula, [...(historico.get(f.matricula) ?? []), f]);

  // A prévia vem com a frequência apurada até o dia 25. Se todos os feriados do mês caem até lá, a HE
  // 100% (trabalho no feriado) já está praticamente completa e não é projetada. O DSR sobre horas
  // extras acompanha a HE projetada (DSR = HE × dias de descanso ÷ dias úteis).
  const feriados = feriadosDoMes(e.competencia);
  const he100Fechada = feriados.every((dia) => dia <= DIA_CORTE_FREQUENCIA);
  const cal = calendarioCompetencia(e.competencia);
  const fatorDsr = cal.diasUteis > 0 ? cal.diasDsr / cal.diasUteis : 0;
  const feriadosSet = new Set(feriados);
  let uteisApurados = 0;
  let uteisRestantes = 0;
  for (let dia = 1; dia <= cal.dias; dia++) {
    if (new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay() === 0 || feriadosSet.has(dia)) continue;
    if (dia <= DIA_CORTE_FREQUENCIA) uteisApurados++;
    else uteisRestantes++;
  }
  const fatorDias = uteisApurados > 0 ? uteisRestantes / uteisApurados : 0;
  let rescisoes = 0;

  for (const f of e.previa) {
    const proventos = soma(f, (_, col) => col === "provento");
    const descontos = soma(f, (_, col) => col === "desconto");
    let liquido = f.eventos.some((x) => x.codigo === "00996") ? val(f, "00996") : proventos - descontos;
    if (proventos === 0 && liquido === 0) continue;
    // Rescisão: o líquido sai do termo de rescisão, à parte; INSS, IR e FGTS seguem nas guias do mês.
    const rescisao = ehRescisao(f);
    if (rescisao) {
      rescisoes++;
      v.rescisoes = (v.rescisoes ?? 0) + liquido;
    }
    let inss = val(f, "00451") + val(f, "00500");
    let ir = val(f, "00453") + val(f, "00481");
    let pensao = val(f, "00469") + val(f, "00470");
    let baseInss = val(f, "00096");
    let baseEmpresa = val(f, "00660");
    let fgts = val(f, "00993");

    // Desligados e afastados entram como estão na prévia (rescisão é valor fechado; afastado não tem
    // variáveis a completar).
    const meses = historico.get(f.matricula) ?? [];
    const ativo = !/^Desligado/i.test(f.situacao) && !(/^Afastado/i.test(f.situacao) && !/MATERNIDADE/i.test(f.situacao));
    if (ativo) {
      const media = (filtro: (codigo: string, coluna: string) => boolean) =>
        meses.length ? meses.reduce((a, m) => a + soma(m, filtro), 0) / meses.length : 0;
      // Horas da prévia (HE 50%, noturno e DSR do noturno; a HE 100% só se houver feriado depois do
      // corte) projetadas pelos dias úteis que faltam, com o DSR sobre a HE projetada.
      const doEvento = (cs: string[]) => soma(f, (c, col) => col === "provento" && cs.includes(c));
      const he = doEvento(["00003", ...(he100Fechada ? [] : ["00363"])]);
      const horas = he + doEvento(["00004", "00119"]);
      let extra = horas * fatorDias + he * fatorDias * fatorDsr;
      // Comissão (e DSR sobre comissão) só entra no fechamento: se a prévia não traz, vale a média.
      const comissao = (c: string, col: string) => col === "provento" && (c === "00707" || c === "00708");
      if (soma(f, comissao) === 0) extra += media(comissao);
      if (extra > 0.005) {
        completados++;
        acrescimoVariaveis += extra;
        const extraBase = extra;
        const novaBase = baseInss + extraBase;
        const novoInss = Math.max(inss + calcularInss(novaBase, p) - calcularInss(baseInss, p), inss);
        const cadastros = e.pensoes.get(f.matricula) ?? [];
        let novaPensao = pensao;
        let novoIr: number;
        if (cadastros.some((c) => c.modalidade === "liquido")) {
          const r = pensaoEIr(cadastros, proventos + extra, novaBase, novoInss, val(f, "00800"), p);
          novaPensao = r.pensao;
          novoIr = r.ir + val(f, "00481");
        } else {
          // IR do salário pela tabela, sobre a base da prévia (00096) antes e depois do acréscimo; a
          // diferença soma ao IR descontado na prévia (o IR das férias, 00481, não muda).
          const irSobre = (bruto: number, inssSal: number) =>
            calcularIr(Math.max(0, Math.min(bruto - inssSal - val(f, "00800") - pensao, bruto - p.irDescontoSimplificado)), bruto, p);
          const bruto = val(f, "00096");
          const inssSalario = val(f, "00451");
          novoIr = ir + Math.max(0, irSobre(bruto + extraBase, inssSalario + (novoInss - inss)) - irSobre(bruto, inssSalario));
        }
        liquido += extra - (novoInss - inss) - (novoIr - ir) - (novaPensao - pensao);
        fgts += extraBase * (ehAprendiz(f.funcao) ? p.fgtsAprendiz : p.fgts);
        baseEmpresa += extraBase;
        baseInss = novaBase;
        inss = novoInss;
        ir = novoIr;
        pensao = novaPensao;
      }
    }

    if (!rescisao) {
      const reg = porArea.get(areaDaDivisao(f.divisao)) ?? { valor: 0, colaboradores: 0 };
      reg.valor += liquido;
      reg.colaboradores++;
      porArea.set(areaDaDivisao(f.divisao), reg);
      v.liquido += liquido;
    }
    v.pensoes += pensao;
    v.fgts += fgts;
    v.consignado += soma(f, (c, col) => col === "desconto" && ehConsignado(c));
    v.inssFuncionarios += inss;
    v.irFuncionarios += ir;
    v.baseInssEmpresa += baseEmpresa;
    v.colaboradores++;
  }

  v.areas = fecharAreas(porArea);
  encargosEmpresa(v, e.aliquotas, e.receita, true);
  const avisos = [
    `Base: folha prévia do ERP da competência (frequência até o dia ${DIA_CORTE_FREQUENCIA}). HE 50% e noturno projetados pelos ${uteisRestantes} dia(s) útil(eis) que faltam (÷ ${uteisApurados} apurados = +${(fatorDias * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%), com o DSR; comissão pela média dos 3 meses quando ainda não está na prévia. ${completados} colaborador(es), + ${moedaTexto(acrescimoVariaveis)} em proventos.`,
    he100Fechada
      ? `HE 100% como está na prévia: ${feriados.length ? `os feriados do mês (${feriados.map((d) => String(d).padStart(2, "0")).join(", ")}) já estão` : "não há feriado no mês"} no período apurado.`
      : `HE 100% também projetada: há feriado depois do dia ${DIA_CORTE_FREQUENCIA}, fora do período apurado.`,
  ];
  if (rescisoes) avisos.push(`${rescisoes} rescisão(ões) fora da provisão (${moedaTexto(v.rescisoes ?? 0)} líquido) — a rescisão tem prévia própria, à parte.`);
  return { ...arredondar(v), avisos, acrescimoVariaveis: arred(acrescimoVariaveis), completados };
}

// Parâmetros de IR do ano seguinte (folha de dezembro paga em janeiro).
function pIrDe(p: ParametrosFolha) {
  return { ir: p.ir, irDependente: p.irDependente, irDescontoSimplificado: p.irDescontoSimplificado, irRedutor: p.irRedutor, irMinimoRetencao: p.irMinimoRetencao };
}

function arredondar(v: ValoresProvisao): ValoresProvisao {
  return {
    ...v,
    liquido: arred(v.liquido),
    rescisoes: arred(v.rescisoes ?? 0),
    pensoes: arred(v.pensoes),
    fgts: arred(v.fgts),
    consignado: arred(v.consignado),
    baseInssEmpresa: arred(v.baseInssEmpresa),
    inssFuncionarios: arred(v.inssFuncionarios),
    irFuncionarios: arred(v.irFuncionarios),
  };
}

// ---------------------------------------------------------------------------------------------------
// 13º salário — 2ª parcela

export type Entrada13 = {
  ano: number;
  base: FuncionarioFolha[]; // última folha mensal importada (quem está ativo)
  ultimas: FuncionarioFolha[][]; // até 3 últimas folhas, para estimar as variáveis de novembro
  ctx: Contexto13; // histórico do ano, 1ª parcela, dezembro anterior, transferidos, pensões
  desligados: Set<string>;
  aliquotas: AliquotasProvisao;
};

export function provisionar13(e: Entrada13): ValoresProvisao & { avisos: string[] } {
  const p = parametrosDoAno(e.ano).parametros;
  const v = vazio();
  const porArea = new Map<string, { valor: number; colaboradores: number }>();
  const avisos: string[] = [];
  const novembroImportado = e.ctx.mesesImportados.has(11);
  let semPrimeira = 0;
  let saidas = 0;

  const historico = new Map<string, FuncionarioFolha[]>();
  for (const folha of e.ultimas) for (const f of folha) historico.set(f.matricula, [...(historico.get(f.matricula) ?? []), f]);

  for (const f of e.base) {
    if (/^Desligado/i.test(f.situacao) || e.desligados.has(f.matricula)) {
      saidas++;
      continue;
    }
    const { avos } = calcularAvos(f, e.ano, e.ctx);
    if (avos === 0) continue;
    const salario = f.salarioBase;
    const um = e.ctx.primeiraParcela?.get(f.matricula);
    const primeira = um ? val(um, "00069") + val(um, "00750") : 0;
    if (!um) semPrimeira++;
    const gratificacao = um && val(um, "00750") > 0 ? 0.4 : 0;
    const valor13 = ((salario * avos) / 12) * (1 + gratificacao);

    // Médias: dez a nov (as mesmas da conferência); novembro estimado pela média das últimas folhas.
    const media = calcularMedia13(f, e.ano, e.ctx);
    let somaVariaveis = media.soma;
    if (!novembroImportado) {
      const meses = historico.get(f.matricula) ?? [];
      const estimativa = meses.length ? meses.reduce((a, m) => a + soma(m, (c) => EVENTOS_MEDIA.includes(c)), 0) / meses.length : 0;
      somaVariaveis += estimativa;
    }
    const medias = somaVariaveis / 12;

    const total = valor13 + medias;
    const adiantFerias = (e.ctx.historico.get(f.matricula) ?? []).reduce((a, m) => a + m.eventos.filter((x) => x.codigo === "00034").reduce((b, x) => b + x.valor, 0), 0);
    const inss = calcularInss(total, p);
    const cadastros = (e.ctx.pensoes?.get(f.matricula) ?? []).filter((c) => c.incide13);
    // 13º: tributação exclusiva, sem o mínimo de retenção.
    const { pensao, ir } = pensaoEIr13(cadastros, total, inss, val(f, "00800"), p);
    const liquido = Math.max(0, total - primeira - adiantFerias - inss - ir - pensao);

    const reg = porArea.get(areaDaDivisao(f.divisao)) ?? { valor: 0, colaboradores: 0 };
    reg.valor += liquido;
    reg.colaboradores++;
    porArea.set(areaDaDivisao(f.divisao), reg);
    v.liquido += liquido;
    v.pensoes += pensao;
    v.inssFuncionarios += inss;
    v.irFuncionarios += ir;
    v.fgts += Math.max(0, total - primeira - adiantFerias) * (ehAprendiz(f.funcao) ? p.fgtsAprendiz : p.fgts);
    v.baseInssEmpresa += total;
    v.colaboradores++;
  }

  if (!novembroImportado) avisos.push("Folha de novembro ainda não importada: as variáveis de novembro nas médias foram estimadas pela média das últimas folhas.");
  if (!e.ctx.primeiraParcela) avisos.push("1ª parcela ainda não importada: o desconto do adiantamento ficou zerado.");
  else if (semPrimeira) avisos.push(`${semPrimeira} colaborador(es) sem 1ª parcela (admitidos depois do adiantamento).`);
  if (saidas) avisos.push(`${saidas} desligado(s) fora da provisão (o 13º sai na rescisão).`);

  v.areas = fecharAreas(porArea);
  encargosEmpresa(v, e.aliquotas, null, false);
  return { ...arredondar(v), avisos };
}

function pensaoEIr13(cadastros: CadastroPensao[], total: number, inss: number, dependentes: number, p: ParametrosFolha) {
  const pIr = { ...p, irMinimoRetencao: 0 };
  const fixa = cadastros
    .filter((c) => c.modalidade !== "liquido")
    .reduce((a, c) => a + (c.modalidade === "fixo" ? c.valorFixo ?? 0 : ((c.percentual ?? 0) / 100) * p.salarioMinimo), 0);
  const pct = cadastros.filter((c) => c.modalidade === "liquido").reduce((a, c) => a + (c.percentual ?? 0), 0) / 100;
  let pensao = 0;
  let ir = 0;
  for (let i = 0; i < 50; i++) {
    const base = Math.max(0, Math.min(total - inss - dependentes - pensao, total - p.irDescontoSimplificado));
    ir = calcularIr(base, total, pIr);
    const nova = arred(fixa + pct * (total - inss - ir));
    if (Math.abs(nova - pensao) < 0.005) break;
    pensao = nova;
  }
  return { pensao, ir };
}

// ---------------------------------------------------------------------------------------------------
// Valores reais de uma folha já importada, no mesmo formato (para previsto × real).

export function valoresDaFolha(
  itens: FuncionarioFolha[],
  tipo: "mensal" | "13_2",
  aliquotas: AliquotasProvisao,
  receita: number | null
): ValoresProvisao {
  const v = vazio();
  const porArea = new Map<string, { valor: number; colaboradores: number }>();
  for (const f of itens) {
    const proventos = soma(f, (_, col) => col === "provento");
    const descontos = soma(f, (_, col) => col === "desconto");
    const liquido = tipo === "mensal" ? (f.eventos.some((x) => x.codigo === "00996") ? val(f, "00996") : proventos - descontos) : val(f, "00110");
    if (proventos === 0 && liquido === 0) continue;
    v.colaboradores++;
    if (tipo === "mensal" && ehRescisao(f)) {
      v.rescisoes = (v.rescisoes ?? 0) + liquido;
    } else {
      const reg = porArea.get(areaDaDivisao(f.divisao)) ?? { valor: 0, colaboradores: 0 };
      reg.valor += liquido;
      reg.colaboradores++;
      porArea.set(areaDaDivisao(f.divisao), reg);
      v.liquido += liquido;
    }
    if (tipo === "mensal") {
      v.pensoes += val(f, "00469") + val(f, "00470");
      v.fgts += val(f, "00993");
      v.consignado += soma(f, (c, col) => col === "desconto" && ehConsignado(c));
      v.inssFuncionarios += val(f, "00451") + val(f, "00500") + val(f, "00452");
      v.irFuncionarios += val(f, "00453") + val(f, "00481");
      v.baseInssEmpresa += val(f, "00660");
    } else {
      v.pensoes += val(f, "00551");
      v.fgts += val(f, "00913");
      v.inssFuncionarios += val(f, "00452");
      v.irFuncionarios += val(f, "00501");
      v.baseInssEmpresa += val(f, "00661") || val(f, "00094");
    }
  }
  v.areas = fecharAreas(porArea);
  encargosEmpresa(v, aliquotas, receita, tipo === "mensal");
  return arredondar(v);
}

