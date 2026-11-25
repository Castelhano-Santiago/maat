"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePodeOperar } from "@/components/permissoes-provider";
import {
  criarProcesso,
  darOk,
  editarProcesso,
  encerrarProcesso,
  excluirProcesso,
  salvarEmails,
  testarEmail,
} from "./actions";

type Conferencia = { id: string; usuarioNome: string; observacao: string | null; createdAt: string };

type Processo = {
  id: string;
  numero: string;
  assunto: string;
  encerrado: boolean;
  encerradoEm: string | null;
  ultimoOkEm: string | null;
  ultimoOkPorNome: string | null;
  pendente: boolean;
  conferencias: Conferencia[];
};

type UltimoEnvio = { createdAt: string; sucesso: boolean; processos: number; erro: string | null } | null;

function dataHora(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FiscalizacaoPainel({
  processos,
  config,
  emailConfigurado,
  ultimoEnvio,
  proximo,
}: {
  processos: Processo[];
  config: { email1: string; email2: string };
  emailConfigurado: boolean;
  ultimoEnvio: UltimoEnvio;
  proximo: string;
}) {
  const podeOperar = usePodeOperar("fiscalizacao");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // cadastro / edição
  const [formAberto, setFormAberto] = useState(false);
  const [editando, setEditando] = useState<Processo | null>(null);
  const [numero, setNumero] = useState("");
  const [assunto, setAssunto] = useState("");

  // OK
  const [okProcesso, setOkProcesso] = useState<Processo | null>(null);
  const [observacao, setObservacao] = useState("");

  // histórico
  const [historico, setHistorico] = useState<Processo | null>(null);

  // e-mails
  const [email1, setEmail1] = useState(config.email1);
  const [email2, setEmail2] = useState(config.email2);

  const abertos = processos.filter((p) => !p.encerrado);
  const encerrados = processos.filter((p) => p.encerrado);
  const pendentes = abertos.filter((p) => p.pendente).length;
  const semDestinatario = !config.email1 && !config.email2;

  function executar(acao: () => Promise<{ error: string | null }>, sucesso: string, depois?: () => void) {
    startTransition(async () => {
      const r = await acao();
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(sucesso);
      depois?.();
      router.refresh();
    });
  }

  function abrirNovo() {
    setEditando(null);
    setNumero("");
    setAssunto("");
    setFormAberto(true);
  }

  function abrirEditar(p: Processo) {
    setEditando(p);
    setNumero(p.numero);
    setAssunto(p.assunto);
    setFormAberto(true);
  }

  function salvarProcesso() {
    if (!numero.trim() || !assunto.trim()) {
      toast.error("Preencha o número e o assunto.");
      return;
    }
    const dados = { numero, assunto };
    executar(
      () => (editando ? editarProcesso(editando.id, dados) : criarProcesso(dados)),
      editando ? "Processo atualizado" : "Processo cadastrado",
      () => setFormAberto(false),
    );
  }

  function confirmarOk() {
    if (!okProcesso) return;
    executar(() => darOk(okProcesso.id, observacao), "OK registrado — sem lembretes deste processo até o próximo dia de lembrete", () => {
      setOkProcesso(null);
      setObservacao("");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Situação do lembrete */}
      <Card>
        <CardHeader>
          <CardTitle>Lembrete por e-mail</CardTitle>
          <CardDescription>
            Às segundas e quintas (se for feriado, no próximo dia útil), às 08h, 11h, 14h e 17h, o sistema manda um e-mail com os
            processos que ainda não receberam o OK. Se o computador for ligado depois das 08h, o lembrete sai assim que o sistema
            abrir. Funciona só enquanto o sistema estiver aberto neste computador.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!emailConfigurado && (
            <p className="rounded-sm border border-border bg-warning-dim px-3 py-2 text-xs text-warning">
              A conta de e-mail que envia os lembretes ainda não foi configurada. Até lá, nenhum e-mail sai.
            </p>
          )}
          {emailConfigurado && semDestinatario && (
            <p className="rounded-sm border border-border bg-warning-dim px-3 py-2 text-xs text-warning">
              Cadastre pelo menos um e-mail abaixo para os lembretes começarem.
            </p>
          )}
          {ultimoEnvio && !ultimoEnvio.sucesso && (
            <p className="rounded-sm border border-border bg-danger-dim px-3 py-2 text-xs text-danger">
              O último envio ({dataHora(ultimoEnvio.createdAt)}) falhou: {ultimoEnvio.erro}. O sistema tenta de
              novo a cada 15 minutos.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="email1">E-mail 1</Label>
              <Input
                id="email1"
                className="w-72"
                value={email1}
                disabled={!podeOperar}
                onChange={(e) => setEmail1(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="email2">E-mail 2</Label>
              <Input
                id="email2"
                className="w-72"
                value={email2}
                disabled={!podeOperar}
                onChange={(e) => setEmail2(e.target.value)}
              />
            </div>
            {podeOperar && (
              <>
                <Button
                  disabled={isPending}
                  onClick={() => executar(() => salvarEmails({ email1, email2 }), "E-mails salvos")}
                >
                  Salvar e-mails
                </Button>
                <Button
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => executar(() => testarEmail(), "E-mail de teste enviado — confira a caixa de entrada")}
                >
                  Enviar e-mail de teste
                </Button>
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-text-3">
            <span>
              último lembrete:{" "}
              {ultimoEnvio
                ? `${dataHora(ultimoEnvio.createdAt)} (${ultimoEnvio.sucesso ? `${ultimoEnvio.processos} processo(s)` : "falhou"})`
                : "nenhum ainda"}
            </span>
            <span>próximo horário: {dataHora(proximo)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Processos em andamento */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[13px] font-bold tracking-[.06em] uppercase">
            Em andamento ({abertos.length})
          </span>
          <span className="font-mono text-[11px] text-text-3">
            {pendentes > 0 ? `${pendentes} aguardando OK` : "todos conferidos"}
          </span>
        </div>
        {podeOperar && <Button onClick={abrirNovo}>Novo processo</Button>}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Número</TableHead>
            <TableHead>Assunto</TableHead>
            <TableHead>Situação</TableHead>
            <TableHead>Último OK</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {abertos.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-text-3">
                Nenhum processo em andamento.
              </TableCell>
            </TableRow>
          )}
          {abertos.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-mono">{p.numero}</TableCell>
              <TableCell>{p.assunto}</TableCell>
              <TableCell>
                {p.pendente ? <Badge variant="warning">Pendente</Badge> : <Badge variant="success">Conferido</Badge>}
              </TableCell>
              <TableCell className="text-xs text-text-2">
                {p.ultimoOkEm ? `${dataHora(p.ultimoOkEm)} · ${p.ultimoOkPorNome ?? ""}` : "—"}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {podeOperar && p.pendente && (
                    <Button size="sm" disabled={isPending} onClick={() => setOkProcesso(p)}>
                      OK, conferi
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setHistorico(p)}>
                    Histórico
                  </Button>
                  {podeOperar && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => abrirEditar(p)}>
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isPending}
                        onClick={() => {
                          if (!confirm(`Encerrar o processo ${p.numero}? Ele deixa de gerar lembretes.`)) return;
                          executar(() => encerrarProcesso(p.id, true), "Processo encerrado");
                        }}
                      >
                        Encerrar
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {encerrados.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer font-mono text-[12px] font-bold tracking-[.06em] text-text-2 uppercase">
            Encerrados ({encerrados.length})
          </summary>
          <Table>
            <TableBody>
              {encerrados.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono">{p.numero}</TableCell>
                  <TableCell>{p.assunto}</TableCell>
                  <TableCell className="text-xs text-text-2">
                    encerrado em {p.encerradoEm ? dataHora(p.encerradoEm) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setHistorico(p)}>
                        Histórico
                      </Button>
                      {podeOperar && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => executar(() => encerrarProcesso(p.id, false), "Processo reaberto")}
                          >
                            Reabrir
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => {
                              if (!confirm(`Excluir o processo ${p.numero} e todo o histórico de conferências?`)) return;
                              executar(() => excluirProcesso(p.id), "Processo excluído");
                            }}
                          >
                            Excluir
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </details>
      )}

      {/* Novo / editar */}
      <Dialog open={formAberto} onOpenChange={setFormAberto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editando ? "Editar processo" : "Novo processo"}</DialogTitle>
            <DialogDescription>Processo de fiscalização acompanhado no DET.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="numero">Número</Label>
              <Input id="numero" value={numero} onChange={(e) => setNumero(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="assunto">Assunto</Label>
              <Input id="assunto" value={assunto} onChange={(e) => setAssunto(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFormAberto(false)}>
              Cancelar
            </Button>
            <Button disabled={isPending} onClick={salvarProcesso}>
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OK do dia */}
      <Dialog open={okProcesso !== null} onOpenChange={(aberto) => !aberto && setOkProcesso(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Conferido no DET</DialogTitle>
            <DialogDescription>
              Processo {okProcesso?.numero} — {okProcesso?.assunto}. Ao confirmar, os lembretes deste processo
              param até o próximo dia de lembrete (segunda ou quinta).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="observacao">O que foi visto no DET (opcional)</Label>
            <Input
              id="observacao"
              placeholder="ex.: sem alteração / auditor pediu complemento"
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOkProcesso(null)}>
              Cancelar
            </Button>
            <Button disabled={isPending} onClick={confirmarOk}>
              Confirmar OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Histórico */}
      <Dialog open={historico !== null} onOpenChange={(aberto) => !aberto && setHistorico(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Histórico de conferências</DialogTitle>
            <DialogDescription>
              Processo {historico?.numero} — {historico?.assunto} (últimas 20)
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {historico?.conferencias.length ? (
              historico.conferencias.map((c) => (
                <div key={c.id} className="flex flex-col gap-0.5 border-b border-border pb-2 text-xs">
                  <span className="font-mono text-text-3">
                    {dataHora(c.createdAt)} · {c.usuarioNome}
                  </span>
                  {c.observacao && <span>{c.observacao}</span>}
                </div>
              ))
            ) : (
              <span className="text-xs text-text-3">Nenhuma conferência registrada ainda.</span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
