// Regras de leitura do texto das páginas das lojas. Script comum (sem import/export): roda na
// página junto com extract.js e também é carregado pelos testes.

/** "R$ 1.234,56" → 1234.56 */
function ofzMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "");
  if (!s) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** "12x R$ 20,18 sem juros" ou "5x de R$ 30,78 sem juros" */
function ofzInstallments(text) {
  const m = String(text).match(/(\d{1,2})\s*x\s*(?:de\s*)?R\$\s*([\d.]+(?:,\d{2})?)\s*sem juros/i);
  if (!m) return null;
  const count = Number(m[1]);
  const value = ofzMoney(m[2]);
  return count >= 2 && value ? { count, value, interest_free: true } : null;
}

/** Mercado Livre: "ou R$ 44,65 em outros meios" (o valor em destaque é o do Pix). */
function ofzOtherMethods(text) {
  const m = String(text).match(/ou\s+R\$\s*([\d.]+(?:,\d{2})?)\s+em\s+outros\s+meios/i);
  return m ? ofzMoney(m[1]) : null;
}

/** "R$ 197,60 no Pix" (Shopee, Amazon). */
function ofzPixPrice(text) {
  const m = String(text).match(/R\$\s*([\d.]+(?:,\d{2})?)\s*(?:<[^>]*>\s*)*no\s+Pix/i);
  return m ? ofzMoney(m[1]) : null;
}

const OFZ_VALUE = "(\\d{1,2}\\s*%|R\\$\\s*[\\d.]+(?:,\\d{2})?)";

/** "10 %" → "10%"; "R$20" → "R$ 20" */
function ofzValue(v) {
  return v
    .replace(/\s+/g, " ")
    .replace(/(\d)\s*%/, "$1%")
    .replace(/R\$\s*/, "R$ ")
    .trim();
}

/**
 * Cupom anunciado no texto. Devolve { code, description } ou null.
 * - Com código: "cupom SUPERVANTAGEM", "use o código PROMO10".
 * - Sem código (de ativar na página): "20% OFF com cupom", "Cupom de 10% OFF", "Aplicar cupom de 10%".
 * Ignora "Saldo no Mercado Pago" (não é cupom).
 */
function ofzCoupon(text) {
  const t = String(text).replace(/\s+/g, " ");
  const value =
    t.match(
      new RegExp(`${OFZ_VALUE}\\s*OFF\\s*(?:com|no|em|usando)?\\s*(?:o\\s+)?cupom`, "i"),
    )?.[1] ??
    t.match(new RegExp(`cupom\\s+(?:de\\s+)?${OFZ_VALUE}\\s*(?:OFF|de desconto)`, "i"))?.[1] ??
    t.match(new RegExp(`Aplicar\\s+cupom\\s+de\\s+${OFZ_VALUE}`, "i"))?.[1] ??
    t.match(
      new RegExp(`Economize\\s+${OFZ_VALUE}\\s+com\\s+(?:o\\s+)?(?:cupom|c[óo]digo)`, "i"),
    )?.[1] ??
    null;
  // Código: palavra em MAIÚSCULAS logo depois de "cupom"/"código" (não "OFF", "DE"...).
  const codeMatch = t.match(
    /(?:cupom|c[óo]digo)(?:\s+promocional)?\s*:?\s+([A-Z][A-Z0-9]{3,19})\b/,
  );
  const code = codeMatch && !/^(OFF|DE|PARA|COM|NO|NA)$/.test(codeMatch[1]) ? codeMatch[1] : null;
  if (code) return { code, description: value ? `${ofzValue(value)} OFF` : "" };
  if (!value) return null;
  return {
    code: null,
    description: `Cupom de ${ofzValue(value)} OFF: ative na página antes de comprar`,
  };
}

/** Link de afiliado no texto/HTML: meli.la, amzn.to, s.shopee.com.br, shope.ee. */
function ofzAffiliateLink(text) {
  const m = String(text).match(
    /https?:\/\/(?:meli\.la|amzn\.to|s\.shopee\.com\.br|shope\.ee)\/[A-Za-z0-9_-]+/,
  );
  return m ? m[0] : null;
}

/** Loja pelo endereço da página. */
function ofzStore(host) {
  if (/mercadolivre\.com\.br|mercadolibre\./.test(host)) return "mercadolivre";
  if (/amazon\.com\.br/.test(host)) return "amazon";
  if (/shopee\.com\.br/.test(host)) return "shopee";
  if (/magazineluiza\.com\.br|magalu\.com/.test(host)) return "magalu";
  return null;
}
