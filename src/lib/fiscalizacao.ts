// Lembrete das fiscalizações em andamento no DET. O DET não avisa quando o auditor mexe num
// processo, então o sistema manda e-mail nas segundas e quintas (se forem dias úteis), nos horários
// abaixo, enquanto houver processo aberto sem OK. Os horários seguem o relógio do computador onde o
// sistema roda.

import { ehDiaUtil } from "@/lib/feriados";

// Último lembrete às 17h: o expediente termina às 18h, e o ciclo recomeça às 08h do próximo dia de lembrete.
export const HORARIOS_ALERTA = [8, 11, 14, 17] as const;

// Dias da semana com lembrete (0 = domingo): segunda e quinta. Se cair em feriado, o lembrete passa
// para o próximo dia útil.
export const DIAS_ALERTA = [1, 4] as const;

export function inicioDoDia(agora: Date): Date {
  return new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
}

export function hojeEhDiaUtil(agora: Date): boolean {
  return ehDiaUtil(new Date(Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate())));
}

// Dia de lembrete = dia útil que é segunda/quinta, ou o primeiro dia útil depois de uma segunda/quinta
// que caiu em feriado (ex.: segunda de carnaval → terça; quinta de Corpus Christi → sexta).
// Regra: olhando de hoje para trás até o dia útil anterior (sem incluí-lo), algum dia é segunda/quinta.
export function ehDiaDeAlerta(agora: Date): boolean {
  if (!hojeEhDiaUtil(agora)) return false;
  for (let i = 0; i < 15; i++) {
    const dia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - i);
    if (i > 0 && hojeEhDiaUtil(dia)) return false;
    if ((DIAS_ALERTA as readonly number[]).includes(dia.getDay())) return true;
  }
  return false;
}

// Início do dia de lembrete mais recente (hoje, se hoje for dia de lembrete).
function ultimoDiaDeAlerta(agora: Date): Date {
  for (let i = 0; i < 30; i++) {
    const dia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - i);
    if (ehDiaDeAlerta(dia)) return dia;
  }
  return inicioDoDia(agora);
}

// Horário de lembrete "da vez" (o mais recente que já passou), ou null fora do expediente/dia de lembrete.
// Se o computador for ligado às 09h30, o da vez é o das 08h — que então é enviado na hora.
export function horarioAtual(agora: Date): number | null {
  if (!ehDiaDeAlerta(agora)) return null;
  const hora = agora.getHours();
  if (hora >= 18) return null;
  const passados = HORARIOS_ALERTA.filter((h) => h <= hora);
  return passados.length ? passados[passados.length - 1] : null;
}

export function chaveHorario(agora: Date, hora: number): string {
  const d = String(agora.getDate()).padStart(2, "0");
  const m = String(agora.getMonth() + 1).padStart(2, "0");
  return `${agora.getFullYear()}-${m}-${d} ${String(hora).padStart(2, "0")}h`;
}

// Processo aberto fica pendente até receber o OK; o OK vale até o próximo dia de lembrete
// (OK na segunda cobre até quarta; na quinta volta a ficar pendente).
export function pendenteHoje(
  p: { encerrado: boolean; ultimoOkEm: Date | null },
  agora: Date,
): boolean {
  if (p.encerrado) return false;
  return !p.ultimoOkEm || p.ultimoOkEm < ultimoDiaDeAlerta(agora);
}

// Próximo horário de lembrete a partir de agora (para mostrar na tela).
export function proximoHorario(agora: Date): Date {
  for (let i = 0; i < 30; i++) {
    const dia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + i);
    if (!ehDiaDeAlerta(dia)) continue;
    for (const h of HORARIOS_ALERTA) {
      const t = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), h);
      if (t > agora) return t;
    }
  }
  return agora;
}
