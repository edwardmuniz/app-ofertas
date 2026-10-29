import type { NextConfig } from "next";

try {
  process.loadEnvFile("../../.env");
} catch {
  // sem .env: usa variáveis do ambiente
}

const apiInternal = process.env.API_INTERNAL_URL ?? "http://localhost:3001";
const apiPublic = process.env.API_PUBLIC_URL ?? "http://localhost:3001";

const config: NextConfig = {
  transpilePackages: ["@ofertas/contracts"],
  env: { MCP_URL: `${apiPublic}/mcp`, API_PUBLIC_URL: apiPublic },
  // O painel chama a API pelo mesmo domínio (/api/*) para o cookie de sessão funcionar.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternal}/:path*` }];
  },
};

export default config;
