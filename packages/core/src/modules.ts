/**
 * Módulos da plataforma e status. Exposto a humanos e agentes no overview para que
 * saibam o que já pode ser usado. Atualize ao concluir cada fase do roadmap.
 */
export const MODULES = [
  {
    key: "foundation",
    name: "Fundação (auth, tokens, auditoria, MCP)",
    status: "available",
    phase: 0,
  },
  { key: "links", name: "Links e rastreamento", status: "available", phase: 1 },
  { key: "offers", name: "Ofertas (Shopee)", status: "available", phase: 2 },
  { key: "publishing", name: "WhatsApp e publicação", status: "planned", phase: 3 },
  { key: "creatives_image", name: "Criativos de imagem", status: "planned", phase: 4 },
  { key: "metrics", name: "Métricas", status: "planned", phase: 5 },
  { key: "instagram", name: "Instagram", status: "planned", phase: 6 },
  { key: "affiliates_more", name: "Outros afiliados", status: "planned", phase: 7 },
  { key: "creatives_video", name: "Criativos de vídeo", status: "planned", phase: 8 },
  { key: "finance", name: "Financeiro", status: "planned", phase: 9 },
  { key: "ads", name: "Anúncios", status: "planned", phase: 10 },
  { key: "growth", name: "Growth", status: "planned", phase: 11 },
] as const;
