import { describe, expect, it } from "vitest";
import {
  isShopeeAffiliateId,
  readCsvRecords,
  shopeeAffiliateLink,
  shopeeFeedItem,
} from "../src/affiliate/shopee-feed";

async function* chunks(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe("feed da Shopee", () => {
  it("lê CSV em pedaços, com BOM, aspas, vírgulas e quebras de linha nos campos", async () => {
    const csv =
      "﻿itemid,title,description,price,sale_price,discount_percentage\r\n" +
      '1,"Fone ""Pro"", preto","linha 1\nlinha 2 – açúcar",100,80,20\r\n' +
      "2,Caneca,,50,50,0\n";
    const rows = [];
    for await (const r of readCsvRecords(chunks(csv, 7))) rows.push(r);
    expect(rows).toEqual([
      {
        itemid: "1",
        title: 'Fone "Pro", preto',
        description: "linha 1\nlinha 2 – açúcar",
        price: "100",
        sale_price: "80",
        discount_percentage: "20",
      },
      {
        itemid: "2",
        title: "Caneca",
        description: "",
        price: "50",
        sale_price: "50",
        discount_percentage: "0",
      },
    ]);
    expect(shopeeFeedItem(rows[0] as Record<string, string>)).toMatchObject({
      externalId: "1",
      price: 80,
      originalPrice: 100,
      discountPct: 20,
    });
    expect(shopeeFeedItem({ itemid: "3", title: "", price: "1" })).toBeNull();
  });

  it("monta o link de comissão a partir da página ou do link curto do feed", () => {
    const page = "https://shopee.com.br/product/447801038/22393211083";
    const expected =
      "https://s.shopee.com.br/an_redir?origin_link=https%3A%2F%2Fshopee.com.br%2Fproduct%2F447801038%2F22393211083&affiliate_id=14354840000&sub_id=12345-aaaa";
    expect(shopeeAffiliateLink(page, "14354840000", ["12345", "aaaa", ""])).toBe(expected);
    expect(
      shopeeAffiliateLink(
        `https://shope.ee/an_redir?origin_link=${encodeURIComponent(page)}`,
        "14354840000",
        ["12345", "a-a-a-a"],
      ),
    ).toBe(expected);
    expect(isShopeeAffiliateId("14354840000")).toBe(true);
    expect(isShopeeAffiliateId("an_1435")).toBe(false);
  });
});
