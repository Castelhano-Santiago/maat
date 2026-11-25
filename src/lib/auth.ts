import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { username } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";
import { SENHA_MINIMO, problemaSenha } from "@/lib/senha";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  // Aceita o próprio endereço pelo qual o sistema foi aberto (ex.: IP da rede local),
  // além do BETTER_AUTH_URL. Sem isso, o login por outro computador dá "Invalid origin".
  trustedOrigins: (request) => {
    const host = request?.headers.get("host");
    return host ? [`http://${host}`, `https://${host}`] : [];
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: SENHA_MINIMO,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "usuario",
        input: false,
      },
      ativo: {
        type: "boolean",
        defaultValue: true,
        input: false,
      },
      trocarSenha: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },
  // Regra de senha forte (src/lib/senha.ts) também no servidor, para qualquer senha nova definida
  // pelo próprio usuário ou no cadastro — não só na validação da tela.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
      const senha =
        ctx.path === "/change-password" || ctx.path === "/reset-password"
          ? body.newPassword
          : ctx.path === "/sign-up/email"
            ? body.password
            : undefined;
      if (typeof senha !== "string") return;
      const problema = problemaSenha(senha);
      if (problema) throw new APIError("BAD_REQUEST", { message: problema });
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // Bloqueia o login de usuário desativado.
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { ativo: true },
          });
          if (user && !user.ativo) {
            throw new APIError("FORBIDDEN", { message: "Usuário desativado. Fale com um administrador." });
          }
        },
      },
    },
    account: {
      update: {
        // Senha trocada pelo próprio usuário (Minha conta / Trocar senha) libera a troca pendente.
        after: async (account) => {
          if (account.userId && account.password) {
            await prisma.user.update({ where: { id: account.userId }, data: { trocarSenha: false } });
          }
        },
      },
    },
  },
  plugins: [username({ minUsernameLength: 3 })],
});
