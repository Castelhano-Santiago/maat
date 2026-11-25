import { prisma } from "@/lib/prisma";
import { escopoEmpresa, requirePermissao } from "@/lib/session";
import { ImprimirButton } from "../programacao-pdf/imprimir-button";

// Aviso de Férias no mesmo modelo do ERP — um por página (em 1 ou 2 vias), para o colaborador
// assinar no DP. Aberto pelo ícone de impressora na Programação e na aba Avisos WhatsApp.

const DIA = 86_400_000;

function data(d: Date | null) {
  return d ? d.toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";
}

function dataPorExtenso(d: Date) {
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" });
}

function formatarCpf(cpf: string | null) {
  const d = (cpf ?? "").replace(/\D/g, "");
  if (d.length !== 11) return cpf ?? "";
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function hojeUTC() {
  const h = new Date();
  return new Date(Date.UTC(h.getFullYear(), h.getMonth(), h.getDate()));
}

function lerData(valor: string | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor ?? "");
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

export default async function AvisoFeriasPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string; vias?: string; data?: string }>;
}) {
  const user = await requirePermissao("ferias", "consultar");
  const { ids: idsParam, vias: viasParam, data: dataParam } = await searchParams;
  const ids = (idsParam ?? "").split(",").filter(Boolean);
  const vias = viasParam === "1" ? 1 : 2;
  // Data do aviso = dia da impressão (pode ser trocada na tela). Não antedatamos automaticamente.
  const emissao = lerData(dataParam) ?? hojeUTC();

  const periodos = await prisma.ferias.findMany({
    where: { id: { in: ids }, funcionario: { empresaId: await escopoEmpresa(user) } },
    include: { funcionario: { include: { empresa: true } } },
  });
  const avisos = periodos
    .filter((p) => p.gozoInicio && p.gozoFim)
    .sort((a, b) => a.gozoInicio!.getTime() - b.gozoInicio!.getTime() || a.funcionario.nome.localeCompare(b.funcionario.nome));

  const menosDe30 = avisos.filter((p) => (p.gozoInicio!.getTime() - emissao.getTime()) / DIA < 30);
  const semCnpj = [...new Set(avisos.filter((p) => !p.funcionario.empresa.cnpj).map((p) => p.funcionario.empresa.abbr ?? p.funcionario.empresa.nome))];
  const semCentroCusto = avisos.filter((p) => !p.funcionario.centroCusto).length;
  const semCpf = avisos.filter((p) => !p.funcionario.cpf).length;

  const linhaCampo = "flex gap-1 text-[13px] leading-6";
  const rotulo = "w-[130px] shrink-0 text-neutral-700";
  const valor = "font-serif font-bold text-neutral-900";
  const faixa = <div className="my-3 h-3 border border-neutral-700 bg-neutral-300" />;

  return (
    <div className="mx-auto min-h-screen max-w-[800px] bg-white px-8 py-8 text-neutral-900 print:m-0 print:min-h-0 print:max-w-none print:p-0">
      {/* Cada aviso ocupa exatamente uma folha A4. Margem da página zerada (o espaço fica dentro do
          aviso) — isso também tira o cabeçalho/rodapé de data e endereço que o navegador imprime —
          e o espaçamento da tela do sistema em volta é anulado na impressão. */}
      <style>{`@media print {
        @page { size: A4 portrait; margin: 0; }
        html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
        main { margin: 0 !important; padding: 0 !important; max-width: none !important; gap: 0 !important; }
      }`}</style>

      <div className="mb-6 flex flex-col gap-3 rounded-md border border-neutral-300 bg-neutral-50 p-4 text-sm print:hidden">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <input type="hidden" name="ids" value={ids.join(",")} />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Vias por colaborador</span>
            <select name="vias" defaultValue={String(vias)} className="rounded border border-neutral-300 px-2 py-1">
              <option value="2">2 vias (empresa e colaborador)</option>
              <option value="1">1 via</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Data do aviso</span>
            <input
              type="date"
              name="data"
              defaultValue={emissao.toISOString().slice(0, 10)}
              className="rounded border border-neutral-300 px-2 py-1"
            />
          </label>
          <button type="submit" className="rounded border border-neutral-400 px-3 py-1.5 text-sm hover:bg-neutral-100">
            Aplicar
          </button>
          <span className="ml-auto text-neutral-600">
            {avisos.length} aviso(s) · {avisos.length * vias} página(s)
          </span>
        </form>
        {menosDe30.length > 0 && (
          <p className="text-amber-700">
            Atenção: {menosDe30.length} aviso(s) com menos de 30 dias até o início das férias (
            {menosDe30.map((p) => p.funcionario.nome).join(", ")}).
          </p>
        )}
        {semCnpj.length > 0 && (
          <p className="text-amber-700">
            CNPJ não cadastrado para: {semCnpj.join(", ")}. Preencha em Empresas → Editar.
          </p>
        )}
        {(semCentroCusto > 0 || semCpf > 0) && (
          <p className="text-neutral-600">
            {semCentroCusto > 0 && `${semCentroCusto} sem centro de custo (vem da coluna DIVISÃO ao importar o relatório de férias). `}
            {semCpf > 0 && `${semCpf} sem CPF no cadastro.`}
          </p>
        )}
        <ImprimirButton />
      </div>

      {avisos.length === 0 && <p className="text-center text-neutral-500">Nenhum aviso para imprimir.</p>}

      {avisos.flatMap((p) => {
        const f = p.funcionario;
        const e = f.empresa;
        const nomeEmpresa = e.nome;
        const diasGozo = p.diasDireito - p.diasAbono;
        return Array.from({ length: vias }, (_, via) => (
          <section
            key={`${p.id}-${via}`}
            className="mb-10 break-after-page last:break-after-auto print:mb-0 print:box-border print:h-[297mm] print:overflow-hidden print:p-[12mm]"
          >
          <div className="flex flex-col border border-neutral-700 px-6 py-5">
            {vias === 2 && (
              <p className="mb-1 text-right text-[10px] tracking-wide text-neutral-500 uppercase">
                {via === 0 ? "Via da empresa" : "Via do colaborador"}
              </p>
            )}
            <h1 className="border border-neutral-700 py-3 text-center text-2xl font-bold tracking-wide">AVISO DE FÉRIAS</h1>
            {faixa}
            <div className={linhaCampo}>
              <span className={rotulo}>Empresa...............:</span>
              <span className={valor}>
                {e.codigo.padStart(3, "0")}&nbsp;&nbsp;{nomeEmpresa}
              </span>
            </div>
            <div className={linhaCampo}>
              <span className={rotulo}>Estabelecimento..:</span>
              <span className={valor}>001&nbsp;&nbsp;{nomeEmpresa}</span>
            </div>
            <div className={linhaCampo}>
              <span className={rotulo}>CNPJ/MF Nº.........:</span>
              <span className={valor}>{e.cnpj ?? ""}</span>
            </div>
            {faixa}
            <div className={linhaCampo}>
              <span className={rotulo}>Funcionário..........:</span>
              <span className={valor}>
                {f.matricula}&nbsp;&nbsp;&nbsp;{f.nomeCompleto ?? f.nome}
              </span>
            </div>
            <div className={linhaCampo}>
              <span className={rotulo}>Centro de Custo...:</span>
              <span className={valor}>{f.centroCusto ?? ""}</span>
            </div>
            <div className={linhaCampo}>
              <span className={rotulo}>CPF......................:</span>
              <span className={valor}>{formatarCpf(f.cpf)}</span>
            </div>
            {faixa}

            <p className="mt-8 text-justify text-[14px] leading-6 indent-8 print:mt-8">
              Pelo presente comunicamos-lhe, nos termos da legislação em vigor, a concessão de férias de acordo com o
              demonstrativo abaixo:
            </p>

            <table className="mt-10 print:mt-8 w-full border-collapse border border-neutral-700 text-center text-[13px]">
              <thead>
                <tr className="bg-neutral-200 font-bold">
                  <th className="border border-neutral-700 px-2 py-1.5">Período Aquisitivo</th>
                  <th className="border border-neutral-700 px-2 py-1.5">Período de Gozo</th>
                  <th className="border border-neutral-700 px-1 py-1.5">Dias Gozo</th>
                  <th className="border border-neutral-700 px-1 py-1.5">Dias Abono</th>
                  <th className="border border-neutral-700 px-1 py-1.5">Dias Faltas</th>
                  <th className="border border-neutral-700 px-1 py-1.5">Já Gozados</th>
                </tr>
              </thead>
              <tbody>
                <tr className="font-serif">
                  <td className="border border-neutral-700 px-2 py-2">
                    {data(p.periodoAquisitivoInicio)} à {data(p.periodoAquisitivoFim)}
                  </td>
                  <td className="border border-neutral-700 px-2 py-2">
                    {data(p.gozoInicio)} à {data(p.gozoFim)}
                  </td>
                  <td className="border border-neutral-700 px-1 py-2">{diasGozo}</td>
                  <td className="border border-neutral-700 px-1 py-2">{p.diasAbono}</td>
                  <td className="border border-neutral-700 px-1 py-2">{p.faltas}</td>
                  <td className="border border-neutral-700 px-1 py-2">0</td>
                </tr>
              </tbody>
            </table>

            <p className="mt-12 text-[13px] indent-4 print:mt-10">
              O registro das férias será atualizado em sua Carteira Digital automaticamente.
            </p>

            <p className="mt-10 text-[13px] leading-6 indent-4 print:mt-8">
              Informamos que deverá sair de férias no dia {dataPorExtenso(p.gozoInicio!)} para retornar ao trabalho no
              primeiro dia após {data(p.gozoFim)}.
            </p>

            <p className="mt-14 text-right text-[13px] print:mt-10">
              {(e.cidadeSede ?? "").toUpperCase() || "________________"}, {dataPorExtenso(emissao)}
            </p>

            {/* Assinaturas logo abaixo da data (como no modelo do ERP); o quadro termina nelas. */}
            <div className="mt-20 grid grid-cols-2 gap-12 pb-2 text-center text-[12px] print:mt-24">
              <div className="border-t border-neutral-800 pt-1 font-serif font-bold">{nomeEmpresa}</div>
              <div className="border-t border-neutral-800 pt-1 font-serif font-bold">
                Ciente do Empregado
                <br />
                (Assinatura)
              </div>
            </div>
          </div>
          </section>
        ));
      })}
    </div>
  );
}
