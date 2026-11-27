"use client";

import { useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  FileSignature,
  FlaskConical,
  ListChecks,
  Printer,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePodeOperar } from "@/components/permissoes-provider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  desfazerAvisoAssinado,
  desfazerAvisoWhatsapp,
  registrarAvisoAssinado,
  registrarAvisoWhatsapp,
} from "./actions";
import type { FeriasLinha } from "./ferias-table";
import {
  celularParaWhatsapp,
  formatarCelular,
  linkWhatsapp,
  textoAvisoFerias,
  type DestinoWhatsapp,
} from "@/lib/whatsapp";

const DIA = 86_400_000;
const CHAVE_MEU_CELULAR = "aviso-whatsapp:meu-celular";
const CHAVE_DESTINO = "aviso-whatsapp:destino";

const inputCls =
  "h-8 rounded-sm border border-border-hi bg-secondary px-2 font-mono text-[11px] text-foreground outline-none focus-visible:border-primary";

// Datas de férias ficam gravadas como meia-noite UTC — "hoje" é comparado no mesmo formato.
function hojeUTC() {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function msParaInput(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function inputParaMs(valor: string) {
  const [a, m, d] = valor.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

function normalizar(texto: string) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
}

function formatarData(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function formatarDataHora(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// Preferências do próprio navegador (celular de teste, WhatsApp Web ou aplicativo). Sem
// armazenamento disponível, ficam só na memória enquanto a tela estiver aberta.
const memoria = new Map<string, string>();
const EVENTO_PREFERENCIA = "aviso-whatsapp:preferencia";

function lerPreferencia(chave: string) {
  try {
    return localStorage.getItem(chave) ?? memoria.get(chave) ?? null;
  } catch {
    return memoria.get(chave) ?? null;
  }
}

function gravarPreferencia(chave: string, valor: string) {
  memoria.set(chave, valor);
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // navegador sem armazenamento — a preferência só não fica lembrada
  }
  window.dispatchEvent(new Event(EVENTO_PREFERENCIA));
}

function assinarPreferencias(avisar: () => void) {
  window.addEventListener("storage", avisar);
  window.addEventListener(EVENTO_PREFERENCIA, avisar);
  return () => {
    window.removeEventListener("storage", avisar);
    window.removeEventListener(EVENTO_PREFERENCIA, avisar);
  };
}

function usePreferencia(chave: string, padrao: string) {
  return useSyncExternalStore(
    assinarPreferencias,
    () => lerPreferencia(chave) ?? padrao,
    () => padrao
  );
}

export function AvisosWhatsapp({
  periodos,
  onAtualizado,
}: {
  periodos: FeriasLinha[];
  onAtualizado: (p: FeriasLinha) => void;
}) {
  // Quem só tem "consultar" em Férias pode ver a lista, imprimir e marcar assinatura — mas não
  // enviar/desfazer aviso de WhatsApp (isso exige "operar").
  const podeOperar = usePodeOperar("ferias");
  const hoje = hojeUTC();
  // Rotina de segunda-feira: quem começa as férias entre 30 e 36 dias depois — assim ninguém
  // recebe o aviso com menos de 30 dias e ninguém fica de fora de uma semana pra outra.
  const [de, setDe] = useState(msParaInput(hoje + 30 * DIA));
  const [ate, setAte] = useState(msParaInput(hoje + 36 * DIA));
  const [empresa, setEmpresa] = useState("");
  // Busca por nome ou matrícula — quando preenchida, ignora o período (acha a pessoa em qualquer mês).
  const [busca, setBusca] = useState("");
  const [ocultarEnviados, setOcultarEnviados] = useState(false);
  const meuCelular = usePreferencia(CHAVE_MEU_CELULAR, "");
  const destino: DestinoWhatsapp = usePreferencia(CHAVE_DESTINO, "web") === "app" ? "app" : "web";
  // Avisos abertos no WhatsApp que ainda esperam o "Já enviei" de quem clicou.
  const [aguardando, setAguardando] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  // Envio em sequência: os marcados na caixinha, abertos um depois do outro.
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [fila, setFila] = useState<{ ids: string[]; posicao: number } | null>(null);
  // Aba do WhatsApp Web aberta pelo sistema — reaproveitada a cada envio. O Chrome apaga o nome da
  // aba quando ela abre um site de fora, então abrir "pelo nome" sempre criava uma aba nova.
  const abaWhatsapp = useRef<Window | null>(null);

  const empresas = useMemo(() => [...new Set(periodos.map((p) => p.empresa))].sort(), [periodos]);

  const lista = useMemo(() => {
    const ini = de ? inputParaMs(de) : -Infinity;
    const fim = ate ? inputParaMs(ate) : Infinity;
    const termo = normalizar(busca);
    return periodos
      .filter((p) => {
        if (!p.gozoInicio || !p.gozoFim) return false;
        if (termo) {
          const alvo = normalizar(`${p.matricula} ${p.nome} ${p.nomeCompleto}`);
          if (!alvo.includes(termo) && !p.matricula.replace(/^0+/, "").startsWith(termo)) return false;
        } else {
          const inicio = new Date(p.gozoInicio).getTime();
          if (inicio < ini || inicio > fim) return false;
        }
        if (empresa && p.empresa !== empresa) return false;
        if (ocultarEnviados && p.avisoWhatsappEm) return false;
        return true;
      })
      .sort((a, b) => a.gozoInicio!.localeCompare(b.gozoInicio!) || a.nome.localeCompare(b.nome));
  }, [periodos, de, ate, empresa, ocultarEnviados, busca]);

  const enviados = lista.filter((p) => p.avisoWhatsappEm).length;
  const semCelular = lista.filter((p) => p.pessoasNoCelular === 0).length;

  function definirPeriodo(diasDe: number, diasAte: number) {
    setDe(msParaInput(hoje + diasDe * DIA));
    setAte(msParaInput(hoje + diasAte * DIA));
  }

  function texto(p: FeriasLinha) {
    return textoAvisoFerias({
      nome: p.nomeCompleto,
      empresa: p.empresa,
      gozoInicio: p.gozoInicio!,
      gozoFim: p.gozoFim!,
      dataPagamento: p.dataPagamento,
      diasAbono: p.diasAbono,
    });
  }

  function abrir(url: string) {
    if (destino === "app") {
      window.location.assign(url);
      return;
    }
    const aba = abaWhatsapp.current;
    if (aba && !aba.closed) {
      aba.location.replace(url);
      aba.focus();
    } else {
      abaWhatsapp.current = window.open(url, "_blank");
    }
  }

  const podeEnviar = (p: FeriasLinha) => !!celularParaWhatsapp(p.telefone) && !p.avisoWhatsappEm;

  // Abre o WhatsApp com o aviso pronto. Retorna false se não abriu (sem celular, ou a pessoa
  // desistiu no alerta de celular compartilhado).
  function abrirAviso(p: FeriasLinha): boolean {
    const cel = celularParaWhatsapp(p.telefone);
    if (!cel) return false;
    if (
      p.pessoasNoCelular > 1 &&
      !window.confirm(
        `${p.nome}: este celular está cadastrado para ${p.pessoasNoCelular} colaboradores. O aviso pode ser visto por outra pessoa. Abrir mesmo assim?`
      )
    ) {
      return false;
    }
    abrir(linkWhatsapp(cel, texto(p), destino));
    return true;
  }

  function enviar(p: FeriasLinha) {
    if (abrirAviso(p)) setAguardando((prev) => new Set(prev).add(p.id));
  }

  // ---- Envio em sequência ----

  function alternarSelecao(id: string) {
    setSelecionados((prev) => {
      const novo = new Set(prev);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }

  // Abre o próximo da fila a partir de `posicao` (pulando quem não abrir). O WhatsApp é aberto
  // ainda dentro do clique — depois de esperar o servidor o navegador bloquearia a nova aba.
  function abrirDaFila(ids: string[], posicao: number) {
    for (let i = posicao; i < ids.length; i++) {
      const p = periodos.find((x) => x.id === ids[i]);
      if (p && podeEnviar(p) && abrirAviso(p)) {
        setFila({ ids, posicao: i });
        return;
      }
    }
    setFila(null);
    setSelecionados(new Set());
    toast.success("Sequência concluída.");
  }

  function iniciarSequencia() {
    // Todos os marcados, mesmo os que saíram da tela por outra busca ou outro período.
    const ids = marcados.map((p) => p.id);
    if (ids.length === 0) {
      toast.error("Marque na caixinha os colaboradores que vão receber o aviso.");
      return;
    }
    abrirDaFila(ids, 0);
  }

  function enviadoEProximo() {
    if (!fila) return;
    const atual = periodos.find((x) => x.id === fila.ids[fila.posicao]);
    abrirDaFila(fila.ids, fila.posicao + 1);
    if (!atual) return;
    startTransition(async () => {
      const r = await registrarAvisoWhatsapp(atual.id);
      if (r.error) {
        toast.error(`${atual.nome}: ${r.error}`);
        return;
      }
      onAtualizado({ ...atual, avisoWhatsappEm: r.avisoWhatsappEm ?? null, avisoWhatsappPor: r.avisoWhatsappPor ?? null });
    });
  }

  function abrirAtualDeNovo() {
    const atual = fila && periodos.find((x) => x.id === fila.ids[fila.posicao]);
    const cel = atual && celularParaWhatsapp(atual.telefone);
    if (atual && cel) abrir(linkWhatsapp(cel, texto(atual), destino));
  }

  const atualDaFila = fila ? periodos.find((x) => x.id === fila.ids[fila.posicao]) : undefined;
  const todosMarcados = lista.length > 0 && lista.every((p) => selecionados.has(p.id));
  // Todos os marcados (servem para imprimir) e, entre eles, os que podem receber WhatsApp.
  const selecionadosTodos = periodos
    .filter((p) => selecionados.has(p.id) && p.gozoInicio)
    .sort((a, b) => a.gozoInicio!.localeCompare(b.gozoInicio!) || a.nome.localeCompare(b.nome));
  const marcados = selecionadosTodos.filter(podeEnviar);
  const marcadosForaDaTela = selecionadosTodos.filter((p) => !lista.some((x) => x.id === p.id)).length;
  const linkImpressao = (ids: string[]) => `/admin/ferias/aviso-pdf?ids=${ids.join(",")}`;

  function marcarAssinado(p: FeriasLinha) {
    startTransition(async () => {
      const r = await registrarAvisoAssinado(p.id);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      onAtualizado({ ...p, avisoAssinadoEm: r.avisoAssinadoEm ?? null, avisoAssinadoPor: r.avisoAssinadoPor ?? null });
      toast.success(`Aviso de ${p.nome} marcado como assinado.`);
    });
  }

  function desfazerAssinado(p: FeriasLinha) {
    if (!window.confirm(`Desmarcar o aviso de ${p.nome} como assinado?`)) return;
    startTransition(async () => {
      const r = await desfazerAvisoAssinado(p.id);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      onAtualizado({ ...p, avisoAssinadoEm: null, avisoAssinadoPor: null });
    });
  }

  function testar(p: FeriasLinha) {
    const meu = celularParaWhatsapp(meuCelular);
    if (!meu) {
      toast.error("Informe o seu celular com DDD no campo “Meu celular para teste”.");
      return;
    }
    abrir(linkWhatsapp(meu, texto(p), destino));
  }

  function tirarDeAguardando(id: string) {
    setAguardando((prev) => {
      const novo = new Set(prev);
      novo.delete(id);
      return novo;
    });
  }

  function confirmarEnvio(p: FeriasLinha) {
    startTransition(async () => {
      const r = await registrarAvisoWhatsapp(p.id);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      onAtualizado({ ...p, avisoWhatsappEm: r.avisoWhatsappEm ?? null, avisoWhatsappPor: r.avisoWhatsappPor ?? null });
      tirarDeAguardando(p.id);
      toast.success(`Aviso de ${p.nome} registrado como enviado.`);
    });
  }

  function desfazer(p: FeriasLinha) {
    if (!window.confirm(`Desfazer o registro de envio do aviso de ${p.nome}?`)) return;
    startTransition(async () => {
      const r = await desfazerAvisoWhatsapp(p.id);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      onAtualizado({ ...p, avisoWhatsappEm: null, avisoWhatsappPor: null });
    });
  }

  return (
    <>
      <p className="font-mono text-[11px] text-text-3">
        Nada é enviado automaticamente. “Enviar aviso” abre o WhatsApp com o número e a mensagem prontos; você confere
        e aperta enviar no WhatsApp. Depois, clique em “Já enviei” para registrar. Para vários de uma vez, marque as
        caixinhas e use “Enviar para os selecionados”: cada “Já enviei → próximo” registra o atual e abre o seguinte.
        Use “Teste” para mandar a mensagem para o seu próprio celular e ver como o colaborador vai receber.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-text-3 uppercase">Buscar colaborador (qualquer mês)</span>
          <span className="flex items-center gap-1">
            <input
              className={`${inputCls} w-64`}
              placeholder="nome ou matrícula..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            {busca && (
              <Button size="icon-sm" variant="ghost" aria-label="Limpar busca" onClick={() => setBusca("")}>
                <X />
              </Button>
            )}
          </span>
        </label>
        <label className={`flex flex-col gap-1 ${busca ? "opacity-40" : ""}`}>
          <span className="font-mono text-[10px] text-text-3 uppercase">Férias começando de</span>
          <input type="date" className={inputCls} value={de} onChange={(e) => setDe(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-text-3 uppercase">até</span>
          <input type="date" className={inputCls} value={ate} onChange={(e) => setAte(e.target.value)} />
        </label>
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => definirPeriodo(30, 36)}>
            Rotina da semana (30 a 36 dias)
          </Button>
          <Button size="sm" variant="secondary" onClick={() => definirPeriodo(0, 29)}>
            Menos de 30 dias
          </Button>
          <Button size="sm" variant="secondary" onClick={() => definirPeriodo(0, 60)}>
            Próximos 60 dias
          </Button>
        </div>
        <select className={inputCls} value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
          <option value="">Todas as empresas</option>
          {empresas.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <label className="flex h-8 items-center gap-1.5 font-mono text-[11px] text-text-2">
          <input type="checkbox" checked={ocultarEnviados} onChange={(e) => setOcultarEnviados(e.target.checked)} />
          ocultar já enviados
        </label>
        <a
          href={`/admin/ferias/pendentes-assinatura-pdf?${new URLSearchParams({
            ...(de && { de }),
            ...(ate && { ate }),
            ...(empresa && { empresa }),
          }).toString()}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Relatório de quem ainda não assinou o aviso, no período filtrado acima"
          className="ml-auto inline-flex items-center gap-[7px] rounded-sm border border-border-hi bg-secondary px-3 py-1.5 font-mono text-[11px] font-bold tracking-[.06em] text-secondary-foreground uppercase hover:opacity-85"
        >
          <FileSignature className="size-3.5" />
          Relatório de quem faltou assinar
        </a>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-text-3 uppercase">Meu celular para teste</span>
          <input
            className={`${inputCls} w-44`}
            placeholder="(65) 99999-9999"
            value={meuCelular}
            onChange={(e) => gravarPreferencia(CHAVE_MEU_CELULAR, e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] text-text-3 uppercase">Abrir no</span>
          <select
            className={inputCls}
            value={destino}
            onChange={(e) => gravarPreferencia(CHAVE_DESTINO, e.target.value)}
          >
            <option value="web">WhatsApp Web (navegador)</option>
            <option value="app">Aplicativo do WhatsApp no computador</option>
          </select>
        </label>
        <p className="pb-2 font-mono text-[11px] text-text-2">
          {lista.length} colaborador(es) no período · {enviados} aviso(s) enviado(s) · {lista.length - enviados}{" "}
          pendente(s)
          {semCelular > 0 && <span className="text-warning"> · {semCelular} sem celular válido</span>}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {selecionadosTodos.length > 0 && !fila && (
            <Button size="sm" variant="ghost" onClick={() => setSelecionados(new Set())}>
              <X />
              Limpar seleção
            </Button>
          )}
          {selecionadosTodos.length > 0 && (
            <a
              href={linkImpressao(selecionadosTodos.map((p) => p.id))}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-[7px] rounded-sm border border-border-hi bg-secondary px-[18px] py-[9px] font-mono text-[11px] font-bold tracking-[.06em] text-secondary-foreground uppercase hover:opacity-85"
            >
              <Printer className="size-3.5" />
              Imprimir avisos ({selecionadosTodos.length})
            </a>
          )}
          {podeOperar && (
            <Button disabled={!!fila || marcados.length === 0} onClick={iniciarSequencia}>
              <ListChecks />
              Enviar para os selecionados ({marcados.length})
            </Button>
          )}
        </div>
      </div>

      {marcadosForaDaTela > 0 && !fila && (
        <p className="font-mono text-[11px] text-text-2">
          {marcadosForaDaTela} selecionado(s) não aparece(m) na lista atual (outra busca ou outro período) — também
          entra(m) no envio.
        </p>
      )}

      {fila && atualDaFila && (
        <div className="flex flex-wrap items-center gap-3 rounded-sm border border-primary bg-primary/10 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] tracking-[.06em] text-primary uppercase">
              Envio em sequência · {fila.posicao + 1} de {fila.ids.length}
            </span>
            <span className="font-mono text-[13px] font-bold text-foreground">
              {atualDaFila.nome} · {formatarCelular(celularParaWhatsapp(atualDaFila.telefone))}
            </span>
            <span className="font-mono text-[11px] text-text-2">
              Aperte enviar no WhatsApp e volte aqui para abrir o próximo.
            </span>
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" onClick={enviadoEProximo}>
              <Check />
              {fila.posicao + 1 < fila.ids.length ? "Já enviei → próximo" : "Já enviei → concluir"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => abrirDaFila(fila.ids, fila.posicao + 1)}>
              <SkipForward />
              Pular
            </Button>
            <Button size="sm" variant="secondary" onClick={abrirAtualDeNovo}>
              <RotateCcw />
              Abrir de novo
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFila(null)}>
              <Square />
              Parar
            </Button>
          </div>
        </div>
      )}

      {lista.length === 0 ? (
        <p className="py-6 text-center font-mono text-[11px] text-text-3">
          Nenhuma férias programada começando nesse período.
        </p>
      ) : (
        <Table containerClassName="max-h-[65vh] overflow-y-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label="Marcar todos que ainda não receberam"
                  title="Marcar todos que ainda não receberam"
                  disabled={!!fila || lista.length === 0}
                  checked={todosMarcados}
                  onChange={() =>
                    setSelecionados((prev) => {
                      const novo = new Set(prev);
                      for (const p of lista) {
                        if (todosMarcados) novo.delete(p.id);
                        else novo.add(p.id);
                      }
                      return novo;
                    })
                  }
                />
              </TableHead>
              <TableHead>Matrícula</TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead>Férias</TableHead>
              <TableHead>Faltam</TableHead>
              <TableHead>Celular</TableHead>
              <TableHead>WhatsApp</TableHead>
              <TableHead>Assinatura</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lista.map((p) => {
              const cel = celularParaWhatsapp(p.telefone);
              const dias = Math.round((new Date(p.gozoInicio!).getTime() - hoje) / DIA);
              const esperando = aguardando.has(p.id);
              return (
                <TableRow key={p.id} className={atualDaFila?.id === p.id ? "bg-primary/10" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${p.nome}`}
                      disabled={!!fila}
                      checked={selecionados.has(p.id)}
                      onChange={() => alternarSelecao(p.id)}
                    />
                  </TableCell>
                  <TableCell>{p.matricula}</TableCell>
                  <TableCell className="font-medium text-foreground">{p.nome}</TableCell>
                  <TableCell>{p.empresa}</TableCell>
                  <TableCell>
                    {formatarData(p.gozoInicio)} a {formatarData(p.gozoFim)}
                  </TableCell>
                  <TableCell className={dias < 30 && !p.avisoWhatsappEm ? "text-warning" : undefined}>
                    {dias} dias
                  </TableCell>
                  <TableCell>
                    {cel ? (
                      <span className="flex flex-col">
                        <span>{formatarCelular(cel)}</span>
                        {p.pessoasNoCelular > 1 && (
                          <span className="flex items-center gap-1 text-[10px] text-warning">
                            <AlertTriangle className="size-3" />
                            usado por {p.pessoasNoCelular} pessoas
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="flex flex-col">
                        <span className="text-destructive">sem celular válido</span>
                        {p.telefone && <span className="text-[10px] text-text-3">{p.telefone}</span>}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {p.avisoWhatsappEm ? (
                      <span className="text-success">
                        Enviado em {formatarDataHora(p.avisoWhatsappEm)}
                        {p.avisoWhatsappPor && <span className="text-text-3"> · {p.avisoWhatsappPor}</span>}
                      </span>
                    ) : esperando ? (
                      <span className="text-warning">Enviou? Confirme ao lado</span>
                    ) : (
                      <span className="text-text-3">Pendente</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {p.avisoAssinadoEm ? (
                      <span className="flex items-center gap-1.5">
                        <span className="text-success" title={p.avisoAssinadoPor ? `marcado por ${p.avisoAssinadoPor}` : undefined}>
                          Assinado em {new Date(p.avisoAssinadoEm).toLocaleDateString("pt-BR")}
                        </span>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Desmarcar assinatura"
                          title="Desmarcar assinatura"
                          disabled={isPending}
                          onClick={() => desfazerAssinado(p)}
                        >
                          <Undo2 />
                        </Button>
                      </span>
                    ) : (
                      <Button size="xs" variant="secondary" disabled={isPending} onClick={() => marcarAssinado(p)}>
                        <FileSignature />
                        Marcar assinado
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      <a
                        href={linkImpressao([p.id])}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Imprimir Aviso de Férias"
                        aria-label={`Imprimir Aviso de Férias de ${p.nome}`}
                        className="inline-flex size-6 items-center justify-center rounded-sm border border-border-hi bg-secondary text-secondary-foreground hover:opacity-85"
                      >
                        <Printer className="size-3.5" />
                      </a>
                      {podeOperar &&
                        (p.avisoWhatsappEm ? (
                          <Button size="xs" variant="ghost" disabled={isPending} onClick={() => desfazer(p)}>
                            <Undo2 />
                            Desfazer
                          </Button>
                        ) : esperando ? (
                          <>
                            <Button size="xs" disabled={isPending} onClick={() => confirmarEnvio(p)}>
                              <Check />
                              Já enviei
                            </Button>
                            <Button size="xs" variant="secondary" onClick={() => tirarDeAguardando(p.id)}>
                              <X />
                              Não enviei
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="xs" variant="secondary" onClick={() => testar(p)}>
                              <FlaskConical />
                              Teste
                            </Button>
                            <Button size="xs" disabled={!cel} onClick={() => enviar(p)}>
                              <Send />
                              Enviar aviso
                            </Button>
                          </>
                        ))}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
