// Aviso de férias pelo WhatsApp — sem integração paga: o sistema só monta o link com o número e o
// texto prontos; quem envia de fato é o DP, conferindo e apertando "enviar" no próprio WhatsApp.

export function digitosTelefone(telefone: string | null | undefined): string {
  return (telefone ?? "").replace(/\D/g, "");
}

// Celular brasileiro no formato DDD + 9 dígitos (11 dígitos, começando com 9 depois do DDD).
// Aceita o número com 0 ou 55 na frente, que às vezes vem do cadastro.
export function celularParaWhatsapp(telefone: string | null | undefined): string | null {
  let d = digitosTelefone(telefone);
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("0")) d = d.slice(1);
  if (d.length !== 11 || d[2] !== "9") return null;
  return d;
}

export function formatarCelular(telefone: string | null | undefined): string {
  const d = digitosTelefone(telefone);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return telefone ?? "";
}

function capitalizar(texto: string): string {
  return texto
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function data(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

export type DadosAvisoFerias = {
  nome: string;
  empresa: string;
  gozoInicio: string;
  gozoFim: string;
  dataPagamento: string | null;
  diasAbono: number;
};

export function textoAvisoFerias(d: DadosAvisoFerias): string {
  const primeiroNome = capitalizar(d.nome.trim().split(/\s+/)[0] ?? "");
  const retorno = new Date(new Date(d.gozoFim).getTime() + 86_400_000).toISOString();
  const linhas = [
    `Olá, ${primeiroNome}! Aqui é o Departamento Pessoal da ${capitalizar(d.empresa)}.`,
    "",
    "Suas férias estão programadas:",
    `• Início: ${data(d.gozoInicio)}`,
    `• Fim: ${data(d.gozoFim)}`,
    `• Retorno ao trabalho: ${data(retorno)}`,
  ];
  if (d.diasAbono > 0) linhas.push(`• Abono pecuniário: ${d.diasAbono} dias`);
  if (d.dataPagamento) linhas.push(`• Pagamento previsto: ${data(d.dataPagamento)}`);
  linhas.push(
    "",
    "Solicitamos que compareça ao Departamento Pessoal para a assinatura do Aviso de Férias.",
    "Em caso de dúvidas, procure o DP."
  );
  return linhas.join("\n");
}

export type DestinoWhatsapp = "web" | "app";

// "web" abre o WhatsApp Web no navegador; "app" abre o aplicativo do WhatsApp instalado no computador.
// Nos dois casos a mensagem só aparece pronta — nada é enviado sem o clique em "enviar".
export function linkWhatsapp(celular: string, texto: string, destino: DestinoWhatsapp): string {
  const numero = `55${celular}`;
  const t = encodeURIComponent(texto);
  return destino === "app"
    ? `whatsapp://send?phone=${numero}&text=${t}`
    : `https://web.whatsapp.com/send?phone=${numero}&text=${t}`;
}
