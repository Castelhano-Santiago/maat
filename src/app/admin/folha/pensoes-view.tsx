"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePodeOperar } from "@/components/permissoes-provider";
import { ROTULO_MODALIDADE, type ModalidadePensao } from "@/lib/folha/pensao";
import { excluirPensao, listarPensoes, salvarPensao, type LinhaPensao } from "./pensoes-actions";
import { StatCard } from "./stat-card";

const ROTULO_EVENTO: Record<string, string> = { "00469": "salário", "00470": "férias", "00551": "13º" };
const moeda = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numeroBr = (s: string) => {
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};
const textoBr = (n: number | null) => (n === null ? "" : n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }));

type Rascunho = {
  modalidade: ModalidadePensao | "";
  valor: string; // percentual ou valor fixo, conforme a modalidade
  incide13: boolean;
  incideFerias: boolean;
  beneficiario: string;
  observacao: string;
};

// Uma linha da tabela = uma pensão (cadastrada, ou nova ainda não salva).
type LinhaTela = { chave: string; id: string | null; matricula: string; nome: string; original: Rascunho | null };

type Cadastro = LinhaPensao["cadastros"][number];

function rascunhoDoCadastro(c: Cadastro): Rascunho {
  return {
    modalidade: c.modalidade,
    valor: textoBr(c.modalidade === "fixo" ? c.valorFixo : c.percentual),
    incide13: c.incide13,
    incideFerias: c.incideFerias,
    beneficiario: c.beneficiario ?? "",
    observacao: c.observacao ?? "",
  };
}

function rascunhoDaSugestao(s: LinhaPensao["sugestao"]): Rascunho {
  return {
    modalidade: s?.modalidade ?? "",
    valor: textoBr(s ? (s.modalidade === "fixo" ? s.valorFixo : s.percentual) : null),
    incide13: true,
    incideFerias: true,
    beneficiario: "",
    observacao: "",
  };
}

const VAZIO: Rascunho = { modalidade: "", valor: "", incide13: true, incideFerias: true, beneficiario: "", observacao: "" };

// Cadastro da pensão alimentícia de cada colaborador (modalidade da decisão judicial), usado na
// conferência do desconto da folha mensal e do 13º. Um colaborador pode ter mais de uma pensão.
export function PensoesView({ empresaId, empresaNome }: { empresaId: string; empresaNome: string }) {
  const podeOperar = usePodeOperar("folha");
  const [colaboradores, setColaboradores] = useState<LinhaPensao[] | null>(null);
  const [extras, setExtras] = useState<Record<string, number>>({}); // pensões novas acrescentadas por matrícula
  const [rascunhos, setRascunhos] = useState<Record<string, Rascunho>>({});
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "sem" | "com">("todos");
  const [carregando, startCarregando] = useTransition();
  const [salvando, startSalvando] = useTransition();

  function carregar() {
    startCarregando(async () => {
      const r = await listarPensoes(empresaId);
      if (r.error) toast.error(r.error);
      setColaboradores(r.linhas);
      setExtras({});
      const novos: Record<string, Rascunho> = {};
      for (const l of r.linhas) {
        for (const c of l.cadastros) novos[c.id] = rascunhoDoCadastro(c);
        if (l.cadastros.length === 0) novos[`novo-${l.matricula}-0`] = rascunhoDaSugestao(l.sugestao);
      }
      setRascunhos(novos);
    });
  }

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId]);

  // Linhas da tabela por colaborador: as pensões cadastradas + as novas (sugestão ou "+ outra pensão").
  const linhasDe = (l: LinhaPensao): LinhaTela[] => {
    const cadastradas = l.cadastros.map((c) => ({ chave: c.id, id: c.id, matricula: l.matricula, nome: l.nome, original: rascunhoDoCadastro(c) }));
    const qtdNovas = (l.cadastros.length === 0 ? 1 : 0) + (extras[l.matricula] ?? 0);
    const novas = Array.from({ length: qtdNovas }, (_, i) => ({ chave: `novo-${l.matricula}-${i}`, id: null, matricula: l.matricula, nome: l.nome, original: null }));
    return [...cadastradas, ...novas];
  };

  const termo = busca.trim().toLowerCase();
  const visiveis = useMemo(
    () =>
      (colaboradores ?? [])
        .filter((l) => filtro === "todos" || (filtro === "com" ? l.cadastros.length > 0 : l.cadastros.length === 0))
        .filter((l) => !termo || l.nome.toLowerCase().includes(termo) || l.matricula.includes(termo)),
    [colaboradores, filtro, termo]
  );

  if (carregando && !colaboradores) return <p className="font-mono text-[11px] text-text-3">carregando pensões...</p>;
  if (!colaboradores) return null;

  const semCadastro = colaboradores.filter((l) => l.cadastros.length === 0).length;
  const totalPensoes = colaboradores.reduce((a, l) => a + l.cadastros.length, 0);

  function atualizar(chave: string, campo: Partial<Rascunho>) {
    setRascunhos((atual) => ({ ...atual, [chave]: { ...(atual[chave] ?? VAZIO), ...campo } }));
  }

  function acrescentar(matricula: string) {
    const i = (colaboradores!.find((l) => l.matricula === matricula)?.cadastros.length === 0 ? 1 : 0) + (extras[matricula] ?? 0);
    setRascunhos((atual) => ({ ...atual, [`novo-${matricula}-${i}`]: VAZIO }));
    setExtras((atual) => ({ ...atual, [matricula]: (atual[matricula] ?? 0) + 1 }));
  }

  async function gravar(linha: LinhaTela): Promise<boolean> {
    const r = rascunhos[linha.chave] ?? VAZIO;
    if (!r.modalidade) {
      toast.error(`${linha.nome}: escolha a modalidade.`);
      return false;
    }
    const numero = numeroBr(r.valor);
    const result = await salvarPensao(empresaId, {
      id: linha.id,
      matricula: linha.matricula,
      nome: linha.nome,
      modalidade: r.modalidade,
      percentual: r.modalidade === "fixo" ? null : numero,
      valorFixo: r.modalidade === "fixo" ? numero : null,
      incide13: r.incide13,
      incideFerias: r.incideFerias,
      beneficiario: r.beneficiario || null,
      observacao: r.observacao || null,
    });
    if (result.error) {
      toast.error(`${linha.nome}: ${result.error}`);
      return false;
    }
    return true;
  }

  function salvarUma(linha: LinhaTela) {
    startSalvando(async () => {
      if (await gravar(linha)) {
        toast.success(`Pensão de ${linha.nome} salva.`);
        carregar();
      }
    });
  }

  function remover(linha: LinhaTela) {
    if (!linha.id) {
      // Pensão nova ainda não salva: só some da tela.
      setExtras((atual) => ({ ...atual, [linha.matricula]: Math.max(0, (atual[linha.matricula] ?? 0) - 1) }));
      return;
    }
    if (!window.confirm(`Excluir esta pensão de ${linha.nome}?`)) return;
    startSalvando(async () => {
      const r = await excluirPensao(empresaId, linha.id!);
      if (r.error) toast.error(r.error);
      else carregar();
    });
  }

  const sugeridasSemCadastro = colaboradores.filter((l) => l.cadastros.length === 0 && rascunhos[`novo-${l.matricula}-0`]?.modalidade);

  function salvarSugestoes() {
    startSalvando(async () => {
      let ok = 0;
      for (const l of sugeridasSemCadastro) {
        if (await gravar({ chave: `novo-${l.matricula}-0`, id: null, matricula: l.matricula, nome: l.nome, original: null })) ok++;
      }
      toast.success(`${ok} pensão(ões) cadastrada(s) com a sugestão.`);
      carregar();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-[11px] text-text-3">
        Colaboradores da {empresaNome} com desconto de pensão nas folhas importadas. Cada pensão é cadastrada uma vez e vale para todas as
        folhas (mensais e 13º) até ser editada. Quem tem mais de uma pensão (ex.: uma sobre o líquido e outra sobre o mínimo) recebe uma linha
        para cada, em &quot;+ outra pensão&quot; — a conferência compara a soma com o desconto do ERP. Para quem ainda não tem cadastro, a
        modalidade vem sugerida pelos valores da folha; confira com a decisão antes de salvar.
      </p>

      <div className="grid grid-cols-3 gap-2.5 sm:max-w-xl">
        <StatCard label="Colaboradores" value={colaboradores.length} cor="neutral" ativo={filtro === "todos"} onClick={() => setFiltro("todos")} />
        <StatCard label="Sem cadastro" value={semCadastro} cor="blue" ativo={filtro === "sem"} onClick={() => setFiltro("sem")} />
        <StatCard label="Pensões cadastradas" value={totalPensoes} cor="green" ativo={filtro === "com"} onClick={() => setFiltro("com")} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <Label>Buscar</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3" />
            <Input className="w-64 pl-8" placeholder="Nome ou matrícula" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
        </div>
        {podeOperar && sugeridasSemCadastro.length > 0 && (
          <Button size="sm" variant="secondary" disabled={salvando} onClick={salvarSugestoes}>
            Salvar as {sugeridasSemCadastro.length} sugestões sem cadastro
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Colaborador</TableHead>
            <TableHead>Último desconto</TableHead>
            <TableHead>Modalidade</TableHead>
            <TableHead className="w-28">% / Valor</TableHead>
            <TableHead>Incide no 13º</TableHead>
            <TableHead>Incide nas férias</TableHead>
            <TableHead>Beneficiário / observação</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {visiveis.map((l) => {
            const linhas = linhasDe(l);
            return (
              <Fragment key={l.matricula}>
                {linhas.map((linha, i) => {
                  const r = rascunhos[linha.chave] ?? VAZIO;
                  const mudou = !linha.original || JSON.stringify(linha.original) !== JSON.stringify(r);
                  const primeira = i === 0;
                  return (
                    <TableRow key={linha.chave} className={primeira ? "" : "border-t-0"}>
                      <TableCell>
                        {primeira ? (
                          <>
                            <div className="font-mono text-[11px] text-text-3">{l.matricula}</div>
                            <div className="text-[13px]">{l.nome}</div>
                            {l.cadastros.length === 0 && (
                              <Badge variant="default" className="mt-1">
                                {l.sugestao ? "sem cadastro · sugerido" : "sem cadastro"}
                              </Badge>
                            )}
                            {l.cadastros.length > 1 && (
                              <Badge variant="outline" className="mt-1">
                                {l.cadastros.length} pensões
                              </Badge>
                            )}
                          </>
                        ) : (
                          <div className="pl-3 font-mono text-[11px] text-text-3">↳ {linha.id ? "outra pensão" : "nova pensão"}</div>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {primeira &&
                          (l.ultimo ? (
                            <>
                              {moeda(l.ultimo.valor)}
                              {l.ultimo.percentual ? ` (${textoBr(l.ultimo.percentual)}%)` : ""}
                              <div className="text-text-3">
                                {l.ultimo.competencia} · {ROTULO_EVENTO[l.ultimo.evento] ?? l.ultimo.evento}
                              </div>
                            </>
                          ) : (
                            <span className="text-text-3">sem desconto nas folhas</span>
                          ))}
                      </TableCell>
                      <TableCell>
                        <Select value={r.modalidade} disabled={!podeOperar} onValueChange={(v) => atualizar(linha.chave, { modalidade: v as ModalidadePensao })}>
                          <SelectTrigger className="w-56">
                            <SelectValue placeholder="Escolher...">{(v: string | null) => (v ? ROTULO_MODALIDADE[v as ModalidadePensao] : null)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(ROTULO_MODALIDADE) as ModalidadePensao[]).map((m) => (
                              <SelectItem key={m} value={m}>
                                {ROTULO_MODALIDADE[m]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {r.modalidade === "fixo" && <span className="font-mono text-[11px] text-text-3">R$</span>}
                          <Input className="w-20" value={r.valor} disabled={!podeOperar} onChange={(e) => atualizar(linha.chave, { valor: e.target.value })} />
                          {r.modalidade && r.modalidade !== "fixo" && <span className="font-mono text-[11px] text-text-3">%</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={r.incide13}
                          disabled={!podeOperar}
                          onChange={(e) => atualizar(linha.chave, { incide13: e.target.checked })}
                        />
                      </TableCell>
                      <TableCell>
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={r.incideFerias}
                          disabled={!podeOperar}
                          onChange={(e) => atualizar(linha.chave, { incideFerias: e.target.checked })}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Input
                            className="w-52"
                            placeholder="beneficiário"
                            value={r.beneficiario}
                            disabled={!podeOperar}
                            onChange={(e) => atualizar(linha.chave, { beneficiario: e.target.value })}
                          />
                          <Input
                            className="w-52"
                            placeholder="nº do processo, observação..."
                            value={r.observacao}
                            disabled={!podeOperar}
                            onChange={(e) => atualizar(linha.chave, { observacao: e.target.value })}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {podeOperar && (
                          <div className="flex flex-col items-start gap-1.5">
                            <div className="flex gap-1.5">
                              <Button size="sm" disabled={salvando || !mudou} onClick={() => salvarUma(linha)}>
                                Salvar
                              </Button>
                              {(linha.id || !primeira) && (
                                <Button size="sm" variant="secondary" disabled={salvando} onClick={() => remover(linha)}>
                                  {linha.id ? "Excluir" : "Cancelar"}
                                </Button>
                              )}
                            </div>
                            {i === linhas.length - 1 && l.cadastros.length > 0 && (
                              <Button size="sm" variant="ghost" disabled={salvando} onClick={() => acrescentar(l.matricula)}>
                                <Plus className="size-3.5" /> outra pensão
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </Fragment>
            );
          })}
          {visiveis.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="font-mono text-[11px] text-text-3">
                Nenhum colaborador nesta seleção.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
