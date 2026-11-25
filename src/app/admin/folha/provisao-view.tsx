"use client";

import { useEffect, useState, useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePodeOperar } from "@/components/permissoes-provider";
import { paraCsv, baixarCsv } from "@/lib/csv";
import { ehDiaUtil } from "@/lib/feriados";
import type { ValoresProvisao } from "@/lib/folha/provisao";
import { buscarProvisao, registrarProvisaoEnviada, salvarAliquotasProvisao, type ResultadoProvisao } from "./provisao-actions";

const moeda = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number | null) => (v === null ? "" : v.toLocaleString("pt-BR", { maximumFractionDigits: 4 }));
const numeroBr = (s: string) => {
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};
const dataBr = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "UTC" });

function proximaCompetencia(c: string) {
  const [m, a] = c.split("/").map(Number);
  return m === 12 ? `01/${a + 1}` : `${String(m + 1).padStart(2, "0")}/${a}`;
}

// Dia `dia` do mês seguinte à competência, antecipado para o dia útil anterior (FGTS Digital, DCTFWeb).
function diaDoMesSeguinte(competencia: string, dia: number) {
  const [m, a] = competencia.split("/").map(Number);
  let d = new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, dia));
  while (!ehDiaUtil(d)) d = new Date(d.getTime() - 86_400_000);
  return d;
}
// 5º dia útil do mês seguinte (salário).
function quintoDiaUtil(competencia: string) {
  const [m, a] = competencia.split("/").map(Number);
  let d = new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, 1));
  let n = 0;
  for (;;) {
    if (ehDiaUtil(d)) n++;
    if (n === 5) return d;
    d = new Date(d.getTime() + 86_400_000);
  }
}
// Dia 20 do próprio mês, antecipado (13º 2ª parcela e INSS do 13º).
function vinteDoMes(competencia: string) {
  const [m, a] = competencia.split("/").map(Number);
  let d = new Date(Date.UTC(a, m - 1, 20));
  while (!ehDiaUtil(d)) d = new Date(d.getTime() - 86_400_000);
  return d;
}

type Linha = {
  secao: string;
  item: string;
  previsto: number;
  enviada: number | null; // provisão registrada como enviada ao financeiro
  comparado: number | null; // folha do ERP da competência (ou mês anterior)
  vencimento: string;
  destaque?: "subtotal" | "total" | "geral";
};

type Valor = (v: ValoresProvisao) => number;

function montarLinhas(r: ResultadoProvisao): Linha[] {
  const p = r.previsto;
  const e: ValoresProvisao | null = r.registrada?.valores ?? null;
  const c: ValoresProvisao | null = r.real ?? r.anterior;
  const mensal = r.tipo === "mensal";
  const vFopag = dataBr(mensal ? quintoDiaUtil(r.competencia) : vinteDoMes(r.competencia));
  const vVinte = dataBr(diaDoMesSeguinte(r.competencia, 20));
  const vInss13 = dataBr(vinteDoMes(r.competencia));
  const titulo = mensal ? `Fopag — ${r.empresaNome} — ${r.competencia}` : `13º salário 2ª parcela — ${r.empresaNome} — ${r.competencia}`;
  const linhas: Linha[] = [];
  const add = (secao: string, item: string, valor: Valor, vencimento: string, destaque?: Linha["destaque"]) =>
    linhas.push({ secao, item, previsto: valor(p), enviada: e ? valor(e) : null, comparado: c ? valor(c) : null, vencimento, destaque });

  const areas = [...new Set([...p.areas, ...(e?.areas ?? []), ...(c?.areas ?? [])].map((a) => a.area))];
  for (const area of areas) add(titulo, area, (v) => v.areas.find((a) => a.area === area)?.valor ?? 0, vFopag);
  add(titulo, "Sub-total (líquido)", (v) => v.liquido, vFopag, "subtotal");
  add(titulo, "Pensões alimentícias (repasse aos beneficiários)", (v) => v.pensoes, vFopag);
  add(titulo, "Total", (v) => v.liquido + v.pensoes, vFopag, "total");

  const fgtsTitulo = "FGTS Digital (GFD)";
  add(fgtsTitulo, "FGTS", (v) => v.fgts, vVinte);
  if (mensal) {
    add(fgtsTitulo, "Empréstimo consignado — guia FGTS", (v) => v.consignado, vVinte);
    add(fgtsTitulo, "Total FGTS + consignado", (v) => v.fgts + v.consignado, vVinte, "total");
  }

  const a = r.aliquotas;
  const darf = "DARF — INSS e IR";
  add(
    darf,
    `INSS empresa (patronal ${pct(a.patronal)}% + terceiros ${pct(a.terceiros)}% + RAT ${a.rat === null ? "não informado" : `${pct(a.rat)}%`})`,
    (v) => v.inssEmpresa,
    mensal ? vVinte : vInss13
  );
  if (mensal && a.cprbReceita > 0) {
    add(
      darf,
      `CPRB ${pct(a.cprbReceita)}% sobre a receita${r.receita ? ` de ${r.receita.competencia} (${moeda(r.receita.valor)})` : " (receita não lançada)"}`,
      (v) => v.cprb,
      vVinte
    );
  }
  add(darf, "INSS funcionários", (v) => v.inssFuncionarios, mensal ? vVinte : vInss13);
  add(darf, "IR funcionários", (v) => v.irFuncionarios, vVinte);
  const totalDarf: Valor = (v) => v.inssEmpresa + v.cprb + v.inssFuncionarios + v.irFuncionarios;
  add(darf, "Total DARF — INSS + IR", totalDarf, "", "total");

  add(
    "Total a provisionar",
    "Total geral (Fopag + FGTS/consignado + DARF)",
    (v) => v.liquido + v.pensoes + v.fgts + (mensal ? v.consignado : 0) + totalDarf(v),
    "",
    "geral"
  );
  return linhas;
}

// Provisão da folha para o caixa/financeiro: prévia da próxima folha mensal ou da 2ª parcela do 13º.
export function ProvisaoView({ empresaId, ultimaMensal }: { empresaId: string; ultimaMensal: string | null }) {
  const podeOperar = usePodeOperar("folha");
  const [tipo, setTipo] = useState<"mensal" | "13_2">("mensal");
  const [competencia, setCompetencia] = useState(ultimaMensal ? proximaCompetencia(ultimaMensal) : "");
  const [dados, setDados] = useState<ResultadoProvisao | null>(null);
  const [aliq, setAliq] = useState({ patronal: "", cprbReceita: "", terceiros: "", rat: "" });
  const [carregando, startCarregando] = useTransition();
  const [salvando, startSalvando] = useTransition();

  function calcular(c = competencia, t = tipo) {
    startCarregando(async () => {
      const r = await buscarProvisao(empresaId, c, t);
      if (r.error) toast.error(r.error);
      setDados(r.data);
      if (r.data) {
        const a = r.data.aliquotas;
        setAliq({ patronal: pct(a.patronal), cprbReceita: pct(a.cprbReceita), terceiros: pct(a.terceiros), rat: pct(a.rat) });
      }
    });
  }

  useEffect(() => {
    if (competencia) calcular();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId]);

  function salvarAliquotas() {
    const patronal = numeroBr(aliq.patronal);
    const terceiros = numeroBr(aliq.terceiros);
    if (patronal === null || terceiros === null) {
      toast.error("Informe o patronal e os terceiros.");
      return;
    }
    startSalvando(async () => {
      const r = await salvarAliquotasProvisao(empresaId, { patronal, terceiros, cprbReceita: numeroBr(aliq.cprbReceita) ?? 0, rat: numeroBr(aliq.rat) });
      if (r.error) toast.error(r.error);
      else {
        toast.success("Alíquotas salvas.");
        calcular();
      }
    });
  }

  const linhas = dados ? montarLinhas(dados) : [];
  const importadaEm = dados?.real ? new Date(dados.real.importadaEm).toLocaleDateString("pt-BR") : "";
  const rotuloComparado = dados?.real
    ? `Folha do ERP${dados.real.simulado ? " (simulada)" : ""} — importada em ${importadaEm}`
    : dados?.anterior
      ? `Mês anterior (${dados.baseCompetencia})`
      : "";

  const enviadaEm = dados?.registrada ? new Date(dados.registrada.registradaEm).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
  const rotuloEnviada = dados?.registrada ? `Enviada em ${enviadaEm}` : "";
  // Com provisão enviada e folha do ERP: diferença = ERP − enviada (quanto a provisão errou).
  // Sem provisão enviada: diferença = previsto − comparação.
  const temDiferenca = !!rotuloComparado;
  const rotuloDiferenca = dados?.registrada ? "ERP − enviada" : "Previsto − comparação";
  const diferenca = (l: Linha) =>
    l.comparado === null ? null : l.enviada !== null && dados?.registrada ? l.comparado - l.enviada : l.previsto - l.comparado;

  function exportar() {
    if (!dados) return;
    const cab = ["Seção", "Item", "Previsto"];
    if (rotuloEnviada) cab.push(rotuloEnviada);
    if (rotuloComparado) cab.push(rotuloComparado, rotuloDiferenca);
    cab.push("Vencimento");
    baixarCsv(
      `provisao-${dados.tipo === "mensal" ? "folha" : "13-2a-parcela"}-${dados.empresaNome.split(" ")[0].toLowerCase()}-${dados.competencia.replace("/", "-")}`,
      paraCsv(
        cab,
        linhas.map((l) => {
          const linha: (string | number)[] = [l.secao, l.item, moeda(l.previsto)];
          if (rotuloEnviada) linha.push(l.enviada === null ? "" : moeda(l.enviada));
          if (rotuloComparado) {
            const d = diferenca(l);
            linha.push(l.comparado === null ? "" : moeda(l.comparado), d === null ? "" : moeda(d));
          }
          linha.push(l.vencimento);
          return linha;
        })
      )
    );
  }

  function registrar() {
    if (!dados) return;
    const aviso = dados.registrada
      ? `Registrar esta provisão como a enviada ao financeiro? Ela substitui a registrada em ${enviadaEm}.`
      : "Registrar esta provisão como a enviada ao financeiro? Depois de importar a folha definitiva, a tela compara com ela.";
    if (!window.confirm(aviso)) return;
    startSalvando(async () => {
      const r = await registrarProvisaoEnviada(empresaId, dados.competencia, dados.tipo);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Provisão registrada como enviada.");
        calcular(dados.competencia, dados.tipo);
      }
    });
  }

  const secoes = [...new Set(linhas.map((l) => l.secao))];

  return (
    <div className="flex flex-col gap-4">
      <p className="font-mono text-[11px] text-text-3">
        Prévia dos valores da folha para provisão no caixa/financeiro. Sem a folha da competência importada: salário atual, variáveis pela
        média das 3 últimas folhas, férias da programação, pensões, e-consignado e as alíquotas do INSS da empresa. Com a folha prévia do ERP
        importada (calculada antes de fechar a frequência): parte dela e completa as variáveis pela média dos 3 meses quando a média for
        maior, colaborador a colaborador.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <Label>Provisão de</Label>
          <Select
            value={tipo}
            onValueChange={(v) => {
              const t = v as "mensal" | "13_2";
              setTipo(t);
              const ano = (competencia || ultimaMensal || "").slice(3);
              const c = t === "13_2" && ano ? `12/${ano}` : competencia;
              setCompetencia(c);
              if (c) calcular(c, t);
            }}
          >
            <SelectTrigger className="w-52">
              <SelectValue>{(v: string | null) => (v === "13_2" ? "13º — 2ª parcela" : "Folha mensal")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mensal">Folha mensal</SelectItem>
              <SelectItem value="13_2">13º — 2ª parcela</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label>Competência</Label>
          <Input className="w-28" placeholder="MM/AAAA" value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
        </div>
        <Button size="sm" disabled={carregando || !competencia} onClick={() => calcular()}>
          {carregando ? "Calculando..." : "Calcular"}
        </Button>
        {dados && (
          <Button size="sm" variant="secondary" onClick={exportar}>
            <Download className="size-3.5" /> Exportar CSV
          </Button>
        )}
        {dados && podeOperar && (
          <Button size="sm" variant="secondary" disabled={salvando} onClick={registrar}>
            Registrar provisão enviada
          </Button>
        )}
      </div>

      {dados && (
        <>
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
            <span className="w-full font-mono text-[11px] tracking-[.04em] text-text-3">Alíquotas do INSS da empresa (%) — valem para todas as provisões desta empresa</span>
            {(
              [
                ["patronal", "Patronal (folha)"],
                ["terceiros", "Terceiros"],
                ["rat", "RAT ajustado"],
                ["cprbReceita", "CPRB (receita)"],
              ] as const
            ).map(([campo, rotulo]) => (
              <div key={campo} className="flex flex-col gap-1.5">
                <Label>{rotulo}</Label>
                <Input
                  className="w-24"
                  value={aliq[campo]}
                  placeholder={campo === "rat" ? "informar" : "0"}
                  disabled={!podeOperar}
                  onChange={(e) => setAliq((a) => ({ ...a, [campo]: e.target.value }))}
                />
              </div>
            ))}
            {podeOperar && (
              <Button size="sm" variant="secondary" disabled={salvando} onClick={salvarAliquotas}>
                Salvar alíquotas
              </Button>
            )}
          </div>

          <p className="font-mono text-[10px] tracking-[.04em] text-text-3">
            {dados.modo === "previa"
              ? `Base: folha prévia do ERP de ${dados.competencia} (importada em ${importadaEm}) · variáveis completadas pela média de ${dados.mesesMedia.join(", ")}`
              : `Base: folha de ${dados.baseCompetencia} · variáveis pela média de ${dados.mesesMedia.join(", ")}`}{" "}
            · {dados.previsto.colaboradores} colaborador(es)
          </p>
          {dados.registrada && (
            <p className="font-mono text-[11px] text-text-2">
              Provisão enviada registrada em {enviadaEm} por {dados.registrada.registradaPor} (base:{" "}
              {dados.registrada.modo === "previa" ? "folha prévia do ERP" : `projeção pela folha de ${dados.registrada.baseCompetencia}`}).
              {dados.real ? " A coluna “ERP − enviada” mostra quanto a provisão ficou acima (negativo) ou abaixo (positivo) da folha do ERP." : ""}
            </p>
          )}
          {dados.avisos.length > 0 && (
            <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-warning">
              {dados.avisos.map((a) => (
                <li key={a}>• {a}</li>
              ))}
            </ul>
          )}

          {secoes.map((secao) => (
            <Table key={secao}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[46%]">{secao}</TableHead>
                  <TableHead className="text-right">Previsto</TableHead>
                  {rotuloEnviada && <TableHead className="text-right">{rotuloEnviada}</TableHead>}
                  {rotuloComparado && <TableHead className="text-right">{rotuloComparado}</TableHead>}
                  {temDiferenca && <TableHead className="text-right">{rotuloDiferenca}</TableHead>}
                  <TableHead className="text-right">Vencimento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linhas
                  .filter((l) => l.secao === secao)
                  .map((l) => (
                    <TableRow key={l.item} className={l.destaque === "geral" ? "bg-warning/15 font-bold" : l.destaque ? "font-semibold" : ""}>
                      <TableCell>{l.item}</TableCell>
                      <TableCell className="text-right font-mono">{moeda(l.previsto)}</TableCell>
                      {rotuloEnviada && <TableCell className="text-right font-mono">{l.enviada === null ? "—" : moeda(l.enviada)}</TableCell>}
                      {rotuloComparado && <TableCell className="text-right font-mono text-text-3">{l.comparado === null ? "—" : moeda(l.comparado)}</TableCell>}
                      {temDiferenca && (
                        <TableCell className="text-right font-mono text-text-3">{diferenca(l) === null ? "—" : moeda(diferenca(l)!)}</TableCell>
                      )}
                      <TableCell className="text-right font-mono text-text-3">{l.vencimento}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          ))}
        </>
      )}
    </div>
  );
}
