import { prisma } from "@/lib/prisma";
import { escopoEmpresa, requirePermissao } from "@/lib/session";
import { limiteProrrogado, EMPRESA_VPAR_OCULTA_FERIAS } from "@/lib/feriados";
import { celularParaWhatsapp } from "@/lib/whatsapp";
import { FeriasTable } from "./ferias-table";

export default async function FeriasPage() {
  const user = await requirePermissao("ferias", "consultar");

  const escopo = await escopoEmpresa(user);
  const [periodos, quinzenas, empresas, telefones] = await Promise.all([
    prisma.ferias.findMany({
      where: { funcionario: { empresaId: escopo, NOT: { empresaId: EMPRESA_VPAR_OCULTA_FERIAS } } },
      orderBy: { dataLimite: "asc" },
      include: {
        funcionario: {
          include: { empresa: true, cargo: true, afastamentos: true },
        },
      },
    }),
    prisma.quinzenaPeriodo.findMany(),
    prisma.empresa.findMany({
      where: { id: escopo, NOT: { id: EMPRESA_VPAR_OCULTA_FERIAS } },
      select: { id: true, nome: true, abbr: true, feriasCalendario: true },
      orderBy: { nome: "asc" },
    }),
    // Só pra contar celulares repetidos (ex.: sócios com um aparelho em comum) — o aviso de férias
    // de um iria parar no celular de outro.
    prisma.funcionario.findMany({
      where: { status: { not: "desligado" }, telefone: { not: null } },
      select: { telefone: true },
    }),
  ]);

  const pessoasPorCelular = new Map<string, number>();
  for (const t of telefones) {
    const cel = celularParaWhatsapp(t.telefone);
    if (cel) pessoasPorCelular.set(cel, (pessoasPorCelular.get(cel) ?? 0) + 1);
  }

  // Calendários de férias: o de quinzenas (compartilhado) e um próprio para cada empresa com uma
  // data por mês (ex.: VPAR, LOGTRANS).
  const nomeEmpresa = (e: { nome: string; abbr: string | null }) => e.abbr ?? e.nome;
  const empresasQuinzena = empresas.filter((e) => e.feriasCalendario !== "mensal");
  const calendarios = [
    ...(empresasQuinzena.length > 0 ? [{ id: "padrao", nome: `Quinzenas — ${empresasQuinzena.map(nomeEmpresa).join(", ")}`, mensal: false }] : []),
    ...empresas.filter((e) => e.feriasCalendario === "mensal").map((e) => ({ id: e.id, nome: nomeEmpresa(e), mensal: true })),
  ];

  const quinzenasSerializadas = quinzenas.map((q) => ({
    calendario: q.calendario,
    ano: q.ano,
    mes: q.mes,
    quinzena: q.quinzena,
    dataInicio: q.dataInicio.toISOString(),
    dataFim: q.dataFim.toISOString(),
  }));

  // Afastados em geral (doença, acidente etc.) não têm previsão confiável de retorno, então
  // programar a férias deles não ajuda — ficam ocultos até voltarem ao normal. Licença
  // maternidade é a exceção: tem data de retorno praticamente certa, então continua aparecendo
  // pra já deixar programado antes dela voltar.
  const ehLicencaMaternidade = (motivo: string | null) =>
    !!motivo && motivo.toLowerCase().includes("matern");

  // Aprendizes não têm direito a férias programadas na mesma régua dos demais colaboradores —
  // ocultado de toda a tela (Programação, Resumo, Painel/Mural) em vez de aparecer como pendente.
  // Colaboradores desligados também saem da programação assim que o desligamento é registrado.
  const periodosSemAprendiz = periodos.filter(
    (p) =>
      !p.funcionario.cargo.nome.trim().toUpperCase().includes("APRENDIZ") &&
      p.funcionario.status !== "desligado" &&
      (p.funcionario.status !== "afastado" || ehLicencaMaternidade(p.funcionario.motivoAfastamento))
  );

  const periodosSerializados = periodosSemAprendiz.map((p) => {
    const { limite: dataLimiteAjustada, diasProrrogados } = limiteProrrogado(
      p.periodoAquisitivoFim,
      p.dataLimite,
      p.funcionario.afastamentos
    );
    return {
      id: p.id,
      matricula: p.funcionario.matricula,
      nome: p.funcionario.nome,
      funcao: p.funcionario.cargo.nome,
      departamento: p.funcionario.cargo.departamento,
      setor: p.funcionario.cargo.setor,
      empresa: p.funcionario.empresa.abbr ?? p.funcionario.empresa.nome,
      calendario: p.funcionario.empresa.feriasCalendario === "mensal" ? p.funcionario.empresaId : "padrao",
      calendarioMensal: p.funcionario.empresa.feriasCalendario === "mensal",
      salario: p.funcionario.temGratificacao
        ? p.funcionario.salario.toNumber() * 1.4
        : p.funcionario.salario.toNumber(),
      periodoAquisitivoInicio: p.periodoAquisitivoInicio.toISOString(),
      periodoAquisitivoFim: p.periodoAquisitivoFim.toISOString(),
      dataLimite: p.dataLimite.toISOString(),
      dataLimiteAjustada: dataLimiteAjustada.toISOString(),
      diasProrrogadosPorAfastamento: diasProrrogados,
      meses: p.meses,
      faltas: p.faltas,
      diasDireito: p.diasDireito,
      mes: p.mes,
      ano: p.ano,
      quinzena: p.quinzena,
      diasAbono: p.diasAbono,
      abonoTipo: p.abonoTipo as "inicio" | "final" | null,
      gozoInicio: p.gozoInicio?.toISOString() ?? null,
      gozoFim: p.gozoFim?.toISOString() ?? null,
      dataPagamento: p.dataPagamento?.toISOString() ?? null,
      status: p.status as "pendente" | "programado" | "concluido",
      exibirMural: p.exibirMural,
      valorReal: p.valorReal?.toNumber() ?? null,
      travado: p.travado,
      nomeCompleto: p.funcionario.nomeCompleto ?? p.funcionario.nome,
      telefone: p.funcionario.telefone,
      pessoasNoCelular: (() => {
        const cel = celularParaWhatsapp(p.funcionario.telefone);
        return cel ? (pessoasPorCelular.get(cel) ?? 1) : 0;
      })(),
      avisoWhatsappEm: p.avisoWhatsappEm?.toISOString() ?? null,
      avisoWhatsappPor: p.avisoWhatsappPor,
      avisoAssinadoEm: p.avisoAssinadoEm?.toISOString() ?? null,
      avisoAssinadoPor: p.avisoAssinadoPor,
      afastado: p.funcionario.status === "afastado",
      motivoAfastamento: p.funcionario.motivoAfastamento,
      // Voltou do afastamento e esse período ainda não foi programado — fácil de passar batido
      // porque ficou fora da lista enquanto estava afastado(a).
      retornouSemProgramar: p.funcionario.status === "ativo" && !!p.funcionario.dataRetorno && !p.gozoInicio,
    };
  });

  return (
    <>
      <div className="flex flex-col gap-1.5 py-1 print:hidden">
        <h1 className="font-mono text-[22px] font-bold tracking-[.08em] text-foreground">
          Programação de Férias
        </h1>
        <p className="font-mono text-[11px] tracking-[.06em] text-text-3">
          importação do relatório do ERP, programação por colaborador e emissão para mural/gestores
        </p>
      </div>
      <FeriasTable periodos={periodosSerializados} quinzenasIniciais={quinzenasSerializadas} calendarios={calendarios} />
    </>
  );
}
