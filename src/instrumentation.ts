// Roda uma vez quando o servidor do sistema sobe. Liga o agendador do lembrete de fiscalizações do
// DET, que confere a cada minuto se chegou a hora de mandar o e-mail (ver src/lib/fiscalizacao.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const global = globalThis as unknown as { agendadorFiscalizacao?: boolean };
  if (global.agendadorFiscalizacao) return;
  global.agendadorFiscalizacao = true;

  const { verificarEEnviarAlerta } = await import("./lib/fiscalizacao-alertas");
  const rodar = () =>
    verificarEEnviarAlerta().catch((e) => console.error("[fiscalizacao] erro no lembrete:", e));
  setTimeout(rodar, 20_000);
  setInterval(rodar, 60_000);
}
