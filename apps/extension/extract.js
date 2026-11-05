// Lê o produto da página aberta (roda na página, depois de parse.js). O valor da última
// expressão é o resultado devolvido para o popup.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const textOf = (el) => (el ? el.innerText || el.textContent || "" : "");
  const meta = (name) =>
    $(`meta[property="${name}"]`)?.content || $(`meta[name="${name}"]`)?.content || null;
  const clean = (s) => (s ? s.replace(/\s+/g, " ").trim() : null);
  const store = ofzStore(location.hostname);
  const out = {
    store,
    page_url: location.href,
    product_url: $('link[rel="canonical"]')?.href || location.href.split("#")[0],
    title: null,
    image_url: null,
    price: null,
    original_price: null,
    pix_price: null,
    installments: null,
    coupon: null,
    affiliate_url: null,
  };

  /**
   * Valor de um preço do Mercado Livre: inteiro e centavos ficam em pedaços separados
   * ("R$" "62" "90"), então o texto corrido viraria 6290.
   */
  const amountOf = (el) => {
    if (!el) return null;
    const fraction = textOf($(".andes-money-amount__fraction", el)).replace(/\D/g, "");
    const cents = textOf($(".andes-money-amount__cents", el)).replace(/\D/g, "");
    if (fraction) return ofzMoney(`${fraction},${cents || "00"}`);
    // Sem as partes: usa o rótulo de acessibilidade ("Antes: 62 reais com 90 centavos").
    const label = el.getAttribute("aria-label") || "";
    const m = label.match(/(\d[\d.]*)\s*reais(?:\s*com\s*(\d{1,2})\s*centavos)?/i);
    return m ? ofzMoney(`${m[1].replace(/\./g, "")},${(m[2] || "0").padStart(2, "0")}`) : null;
  };

  /** Link de afiliado em qualquer lugar da página: texto, campos e links. */
  const findAffiliate = () => {
    const fields = [...document.querySelectorAll("input, textarea")].map((i) => i.value).join(" ");
    const links = [...document.querySelectorAll("a[href]")].map((a) => a.href).join(" ");
    return ofzAffiliateLink(`${fields} ${links} ${document.body.innerText}`);
  };

  if (store === "mercadolivre") {
    out.title = clean(textOf($("h1.ui-pdp-title"))) || clean(meta("og:title"));
    const img = $(".ui-pdp-gallery__figure img") || $("figure img");
    out.image_url = img?.getAttribute("data-zoom") || img?.src || meta("og:image");
    // Bloco de compra deste produto: o menor pedaço da página, a partir do título, que já tem
    // preço. Assim recomendações e carrosséis de outros produtos ficam de fora.
    let block = $("h1.ui-pdp-title") || $("h1");
    for (let i = 0; block && i < 10 && !block.querySelector(".andes-money-amount"); i++) {
      block = block.parentElement;
    }
    block = block || document.body;
    const blockText = textOf(block);
    const previous = $(".andes-money-amount--previous", block);
    const current = [...block.querySelectorAll(".andes-money-amount")].find(
      (e) => !e.classList.contains("andes-money-amount--previous") && !e.closest("s"),
    );
    const main = amountOf(current) || ofzMoney($('meta[itemprop="price"]')?.content);
    out.original_price = amountOf(previous);
    /** Preço da menor parte do bloco cujo texto bate com `re` (ex.: "em outros meios"). */
    const amountNear = (re) => {
      const hits = [...block.querySelectorAll("*")].filter(
        (e) => re.test(e.textContent || "") && e.querySelector(".andes-money-amount"),
      );
      const deepest = hits.find((e) => !hits.some((o) => o !== e && e.contains(o)));
      return deepest
        ? { el: deepest, value: amountOf(deepest.querySelector(".andes-money-amount")) }
        : null;
    };
    // "R$ 35,72 no Pix · ou R$ 44,65 em outros meios": o destaque é o Pix.
    const other = amountNear(/em outros meios/i)?.value || ofzOtherMethods(blockText);
    if (main && other && other > main) {
      out.price = other;
      out.pix_price = main;
    } else {
      out.price = main;
    }
    // "ou 2x R$ 27,99" / "12x R$ 20,18 sem juros"
    const inst = amountNear(/\d{1,2}\s*x/);
    const count = Number((inst?.el.textContent || "").match(/(\d{1,2})\s*x/)?.[1]);
    out.installments =
      inst?.value && count >= 2
        ? {
            count,
            value: inst.value,
            // Só "sem juros" quando a página diz; senão a mensagem não promete.
            interest_free: /sem juros/i.test(inst.el.textContent || ""),
          }
        : ofzInstallments(blockText);
    const promo = [
      ...block.querySelectorAll('[class*="coupon"], [class*="promotion"], [class*="ui-vpp"]'),
    ]
      .map(textOf)
      .join(" ");
    out.coupon = ofzCoupon(promo) || ofzCoupon(blockText);
    out.affiliate_url = findAffiliate();
  } else if (store === "amazon") {
    out.title = clean(textOf($("#productTitle"))) || clean(meta("og:title"));
    const img = $("#landingImage") || $("#imgBlkFront");
    out.image_url = img?.getAttribute("data-old-hires") || img?.src || null;
    const core =
      $("#corePriceDisplay_desktop_feature_div") || $("#corePrice_feature_div") || document;
    out.price = ofzMoney(textOf($(".a-price:not(.a-text-price) .a-offscreen", core)));
    out.original_price = ofzMoney(textOf($(".basisPrice .a-offscreen", core)));
    out.pix_price = ofzPixPrice(document.body.innerHTML);
    out.installments = ofzInstallments(document.body.innerText);
    const promo = [
      "#promoPriceBlockMessage_feature_div",
      "#couponBadge",
      "#vpcButton",
      "#applicable_promotion_list_sec",
    ]
      .map((s) => textOf($(s)))
      .join(" ");
    out.coupon = ofzCoupon(promo);
    // Barra de Associados (SiteStripe): link curto amzn.to depois de "Obter link".
    out.affiliate_url =
      $("#amzn-ss-text-shortlink-textarea")?.value || ofzAffiliateLink(document.body.innerText);
  } else {
    // Shopee, Magalu e outras: dados gerais da página; o preço é conferido no formulário.
    out.title =
      clean(meta("og:title"))?.replace(/\s*\|\s*Shopee Brasil\s*$/i, "") || clean(document.title);
    out.image_url = meta("og:image");
    const text = document.body.innerText;
    out.pix_price = ofzPixPrice(text);
    const prices = [...text.matchAll(/R\$\s*([\d.]+(?:,\d{2})?)/g)].map((m) => ofzMoney(m[1]));
    out.price = prices.find((p) => p && p !== out.pix_price) ?? null;
    out.installments = ofzInstallments(text);
    out.coupon = ofzCoupon(text);
    out.affiliate_url = findAffiliate();
  }
  if (out.pix_price && out.price && out.pix_price >= out.price) out.pix_price = null;
  if (out.original_price && out.price && out.original_price <= out.price) out.original_price = null;
  return out;
})();
