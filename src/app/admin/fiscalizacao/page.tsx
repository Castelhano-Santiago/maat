import { prisma } from "@/lib/prisma";
import { requirePermissao } from "@/lib/session";
import { emailConfigurado } from "@/lib/email";
import { pendenteHoje, proximoHorario } from "@/lib/fiscalizacao";
import { lerConfig } from "@/lib/fiscalizacao-alertas";
import { FiscalizacaoPainel } from "./fiscalizacao-painel";

export default async function FiscalizacaoPage() {
  await requirePermissao("fiscalizacao", "consultar");
  const agora = new Date();
  const [processos, config, ultimoEnvio] = await Promise.all([
    prisma.fiscalizacaoProcesso.findMany({
      orderBy: [{ encerrado: "asc" }, { createdAt: "asc" }],
      include: { conferencias: { orderBy: { createdAt: "desc" }, take: 20 } },
    }),
    lerConfig(),
    prisma.fiscalizacaoAlertaEnvio.findFirst({ orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <>
      <div className="flex flex-col gap-1.5 py-1">
        <h1 className="font-mono text-[22px] font-bold tracking-[.08em] text-foreground">Fiscalização DET</h1>
        <p className="font-mono text-[11px] tracking-[.06em] text-text-3">
          processos em andamento no domicílio eletrônico trabalhista — lembrete por e-mail às segundas e quintas,
          às 08h, 11h, 14h e 17h, até o OK
        </p>
      </div>
      <FiscalizacaoPainel
        processos={processos.map((p) => ({
          id: p.id,
          numero: p.numero,
          assunto: p.assunto,
          encerrado: p.encerrado,
          encerradoEm: p.encerradoEm?.toISOString() ?? null,
          ultimoOkEm: p.ultimoOkEm?.toISOString() ?? null,
          ultimoOkPorNome: p.ultimoOkPorNome,
          pendente: pendenteHoje(p, agora),
          conferencias: p.conferencias.map((c) => ({
            id: c.id,
            usuarioNome: c.usuarioNome,
            observacao: c.observacao,
            createdAt: c.createdAt.toISOString(),
          })),
        }))}
        config={config}
        emailConfigurado={emailConfigurado()}
        ultimoEnvio={
          ultimoEnvio
            ? {
                createdAt: ultimoEnvio.createdAt.toISOString(),
                sucesso: ultimoEnvio.sucesso,
                processos: ultimoEnvio.processos,
                erro: ultimoEnvio.erro,
              }
            : null
        }
        proximo={proximoHorario(agora).toISOString()}
      />
    </>
  );
}
