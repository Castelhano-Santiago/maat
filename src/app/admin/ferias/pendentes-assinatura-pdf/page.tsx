import { prisma } from "@/lib/prisma";
import { escopoEmpresa, requirePermissao } from "@/lib/session";
import { EMPRESA_VPAR_OCULTA_FERIAS } from "@/lib/feriados";
import { ImprimirButton } from "./imprimir-button";

function formatarData(d: Date | null) {
  return d ? d.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
}

export default async function PendentesAssinaturaPdfPage({
  searchParams,
}: {
  searchParams: Promise<{ de?: string; ate?: string; empresa?: string }>;
}) {
  const user = await requirePermissao("ferias", "consultar");
  const { de, ate, empresa } = await searchParams;

  const periodos = await prisma.ferias.findMany({
    where: {
      gozoInicio: {
        not: null,
        ...(de && { gte: new Date(de) }),
        ...(ate && { lte: new Date(ate) }),
      },
      avisoAssinadoEm: null,
      funcionario: {
        status: { not: "desligado" },
        empresaId: await escopoEmpresa(user),
        NOT: { empresaId: EMPRESA_VPAR_OCULTA_FERIAS },
      },
    },
    include: { funcionario: { include: { empresa: true, cargo: true } } },
    orderBy: { gozoInicio: "asc" },
  });

  let linhas = periodos.map((p) => ({
    id: p.id,
    matricula: p.funcionario.matricula,
    nome: p.funcionario.nome,
    departamento: p.funcionario.cargo.departamento,
    empresa: p.funcionario.empresa.abbr ?? p.funcionario.empresa.nome,
    telefone: p.funcionario.telefone,
    gozoInicio: p.gozoInicio,
    gozoFim: p.gozoFim,
    avisoWhatsappEm: p.avisoWhatsappEm,
  }));

  if (empresa) linhas = linhas.filter((l) => l.empresa === empresa);

  const periodoTexto = de || ate ? `${formatarData(de ? new Date(de) : null)} a ${formatarData(ate ? new Date(ate) : null)}` : "todas as datas";
  const emitidoEm = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  return (
    <div className="mx-auto min-h-screen max-w-4xl bg-white px-8 py-10 text-neutral-900 print:px-0 print:py-0">
      <ImprimirButton />

      <div className="mb-8 flex items-start justify-between border-b-2 border-neutral-800 pb-5">
        <div>
          <p className="text-lg font-bold tracking-tight text-neutral-900">
            Férias — Pendentes de Assinatura do Aviso
          </p>
          <p className="text-sm text-neutral-500">
            {linhas.length} colaborador(es) · gozo entre {periodoTexto}
            {empresa && ` · ${empresa}`}
          </p>
        </div>
        <p className="text-right text-xs text-neutral-400">Emitido em {emitidoEm}</p>
      </div>

      <table className="mb-2 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-neutral-800 text-left text-[11px] tracking-wide text-neutral-500 uppercase">
            <th className="py-2 pr-2">Matrícula</th>
            <th className="px-2 py-2">Nome</th>
            <th className="px-2 py-2">Departamento</th>
            <th className="px-2 py-2">Empresa</th>
            <th className="px-2 py-2">Gozo</th>
            <th className="px-2 py-2">Aviso WhatsApp</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.id} className="border-b border-neutral-200">
              <td className="py-2 pr-2 tabular-nums text-neutral-600">{l.matricula}</td>
              <td className="px-2 py-2 font-medium text-neutral-900">{l.nome}</td>
              <td className="px-2 py-2 text-neutral-600">{l.departamento ?? "—"}</td>
              <td className="px-2 py-2 text-neutral-600">{l.empresa}</td>
              <td className="px-2 py-2 text-neutral-600">
                {formatarData(l.gozoInicio)} a {formatarData(l.gozoFim)}
              </td>
              <td className="px-2 py-2 text-neutral-600">
                {l.avisoWhatsappEm ? `Enviado em ${formatarData(l.avisoWhatsappEm)}` : "Não enviado"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-neutral-800 text-[11px] font-medium text-neutral-500 uppercase">
            <td className="pt-2" colSpan={6}>
              Total — {linhas.length} pendente(s)
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
