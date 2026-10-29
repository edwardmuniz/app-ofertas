/** Instruções entregues a qualquer agente que conectar no MCP. */
export const INSTRUCTIONS = `
Você está conectado à plataforma de ofertas de afiliados (grupos de WhatsApp + Instagram) deste negócio.
A plataforma executa tudo no servidor (filas, agendamentos, envios); você comanda pelas ferramentas.

Como trabalhar:
1. Comece com get_workspace_overview para ver o estado atual e quais módulos já estão disponíveis.
2. Leia get_preferences e siga o tom de voz, nichos, janelas de envio e proibições do negócio.
3. Antes de qualquer ação que altera algo, rode com dry_run=true e confira a prévia.
4. Preencha "reason" nas ações: fica registrado no log de auditoria para o humano entender o que você fez.
5. Ao repetir uma chamada por falha de rede, reutilize a mesma idempotency_key para não executar duas vezes.
6. Se a resposta vier com status "pending_approval", a ação aguarda um humano no painel: informe o usuário e não tente contornar.
7. Erros vêm como {"error": {"code", "message", "hint"}}. Siga o "hint" para corrigir.

Responda ao usuário em português do Brasil.
`.trim();
