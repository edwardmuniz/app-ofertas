/**
 * Chave de "família" do produto: o mesmo item em outra cor ou outro anúncio idêntico.
 * A Amazon dá um ASIN por cor ("… (Azul)", "… - Rosa Escuro") e a Shopee tem vários
 * vendedores com o mesmo título; para a curadoria isso é tudo o mesmo produto.
 */
const VARIANT_WORDS = new Set([
  "preto",
  "preta",
  "branco",
  "branca",
  "azul",
  "verde",
  "vermelho",
  "vermelha",
  "rosa",
  "pink",
  "amarelo",
  "amarela",
  "roxo",
  "roxa",
  "lilas",
  "cinza",
  "prata",
  "prateado",
  "prateada",
  "dourado",
  "dourada",
  "bege",
  "marrom",
  "creme",
  "laranja",
  "grafite",
  "nude",
  "vinho",
  "caramelo",
  "transparente",
  "claro",
  "clara",
  "escuro",
  "escura",
  "cor",
  "cores",
]);

/** Títulos curtos demais juntariam produtos diferentes: ficam sem chave. */
const MIN_KEY_LENGTH = 15;

export function productFamilyKey(platform: string, title: string): string | null {
  const words = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !VARIANT_WORDS.has(w));
  const key = words.join(" ");
  return key.length >= MIN_KEY_LENGTH ? `${platform}:${key}` : null;
}
