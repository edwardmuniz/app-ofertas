"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const f = new FormData(e.currentTarget);
    try {
      if (mode === "login") {
        await api("/auth/login", {
          method: "POST",
          body: { email: f.get("email"), password: f.get("password") },
        });
      } else {
        await api("/auth/signup", {
          method: "POST",
          body: {
            name: f.get("name"),
            email: f.get("email"),
            password: f.get("password"),
            workspace_name: f.get("workspace_name"),
          },
        });
      }
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível conectar à API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">{mode === "login" ? "Entrar" : "Criar conta"}</h1>
        {mode === "signup" && (
          <>
            <div>
              <label className="label" htmlFor="name">
                Seu nome
              </label>
              <input className="input" id="name" name="name" required />
            </div>
            <div>
              <label className="label" htmlFor="workspace_name">
                Nome do negócio
              </label>
              <input className="input" id="workspace_name" name="workspace_name" required />
            </div>
          </>
        )}
        <div>
          <label className="label" htmlFor="email">
            E-mail
          </label>
          <input className="input" id="email" name="email" type="email" required />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Senha
          </label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            minLength={mode === "signup" ? 8 : 1}
            required
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn w-full" disabled={loading} type="submit">
          {loading ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
        </button>
        <button
          type="button"
          className="w-full text-sm text-neutral-500 hover:underline"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "Primeiro acesso? Criar conta" : "Já tenho conta"}
        </button>
      </form>
    </main>
  );
}
