// Regra de senha do sistema (definida pelo DP em 25/11/2026): no mínimo 8 caracteres, com pelo
// menos uma letra, um número e um caractere especial. Arquivo usado no navegador (formulários) e no
// servidor (cadastro de usuário, redefinição pelo admin e troca de senha pelo próprio usuário).

import { z } from "zod";

export const SENHA_MINIMO = 8;

export const REGRA_SENHA_TEXTO =
  "Mínimo de 8 caracteres, com pelo menos uma letra, um número e um caractere especial (ex.: @ # $ ! .)";

// Devolve a mensagem do que falta, ou null se a senha atende a regra.
export function problemaSenha(senha: string): string | null {
  if (senha.length < SENHA_MINIMO) return `A senha precisa ter no mínimo ${SENHA_MINIMO} caracteres`;
  if (!/\p{L}/u.test(senha)) return "A senha precisa ter pelo menos uma letra";
  if (!/\d/.test(senha)) return "A senha precisa ter pelo menos um número";
  if (!/[^\p{L}\d\s]/u.test(senha)) return "A senha precisa ter pelo menos um caractere especial (ex.: @ # $ ! .)";
  return null;
}

export const senhaForte = z.string().superRefine((senha, ctx) => {
  const problema = problemaSenha(senha);
  if (problema) ctx.addIssue({ code: "custom", message: problema });
});
