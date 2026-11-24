// Funções compartilhadas pelas APIs da loja (não é uma rota).
import { CATALOGO } from "./_catalogo.js";

export const ETAPAS = ["Pedido realizado", "Pagamento confirmado", "Aguardando envio", "Enviado", "Entregue"];
export const TAXA_CREDITO = { 1: 3.15, 2: 5.39, 3: 6.12, 4: 6.85, 5: 7.57, 6: 8.28, 7: 8.99, 8: 9.69, 9: 10.38, 10: 11.06, 11: 11.74, 12: 12.4 };
export const PARCELA_MINIMA = 5;
export const FRETE_GRATIS_ACIMA = { valor: 150, cidades: [["castilho", "SP"], ["andradina", "SP"]] };
export const IBGE_TRES_LAGOAS = "5008305";

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const digits = (s) => String(s || "").replace(/\D/g, "");
export const tel = (s) => { const d = digits(s); return d.length > 11 ? d.slice(-11) : d; };
export const txt = (s, n) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, n);
export const money = (v) => Math.round(Number(v) * 100) / 100;
export const norm = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/* ---------- criptografia ---------- */
const enc = new TextEncoder();
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s)))); }

export async function hashSenha(senha, saltHex) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
  return { salt: hex(salt), hash: hex(bits) };
}

const segredo = (env) => env.SESSION_SECRET || env.ADMIN_PASSWORD || "";
async function hmac(env, dados) {
  const key = await crypto.subtle.importKey("raw", enc.encode(segredo(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(dados)));
}
export async function criarToken(env, email) {
  const corpo = b64u(enc.encode(JSON.stringify({ e: email, x: Date.now() + 30 * 86400000 })));
  return corpo + "." + b64u(await hmac(env, corpo));
}
export async function lerToken(env, token) {
  if (!segredo(env) || typeof token !== "string" || !token.includes(".")) return null;
  const [corpo, sig] = token.split(".");
  try {
    if (!iguais(await hmac(env, corpo), unb64u(sig))) return null;
    const o = JSON.parse(new TextDecoder().decode(unb64u(corpo)));
    return o.x > Date.now() ? String(o.e) : null;
  } catch { return null; }
}
export async function senhaAdminOk(env, senha) {
  const real = env.ADMIN_PASSWORD;
  if (!real || real.length < 6 || typeof senha !== "string") return false;
  return iguais(await sha(senha), await sha(real));
}

/* ---------- pedidos no KV ---------- */
export const chavePedido = (n) => "p:" + n;
export async function lerPedido(kv, numero) {
  const n = digits(numero); if (!n) return null;
  return (await kv.get(chavePedido(n), "json")) || (await kv.get(n, "json"));
}
export async function gravarPedido(kv, p) {
  // pedidos antigos continuam na chave sem prefixo; os novos usam "p:"
  const antigo = await kv.get(p.numero);
  await kv.put(antigo !== null ? p.numero : chavePedido(p.numero), JSON.stringify(p));
}
export function numeroNovo() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  return d.toISOString().slice(2, 10).replace(/-/g, "") + String(Math.floor(10000 + Math.random() * 90000));
}

/* ---------- valores ---------- */
export function valorComTaxa(base, forma, parcelas) {
  if (forma !== "credito") return { total: money(base), taxa: 0 };
  const t = (TAXA_CREDITO[parcelas] || TAXA_CREDITO[1]) / 100;
  const total = Math.round((base / (1 - t)) * 100) / 100;
  return { total, taxa: money(total - base) };
}

/* ---------- frete (Melhor Envio) ---------- */
export async function cotarFrete(env, cep, itens) {
  const token = env.ME_TOKEN, origem = digits(env.ORIGEM_CEP), contato = env.ME_CONTATO;
  if (!token || origem.length !== 8 || !contato)
    return { erro: "Frete não configurado no servidor.", detalhe: "faltam variáveis: " + [!token && "ME_TOKEN", origem.length !== 8 && "ORIGEM_CEP", !contato && "ME_CONTATO"].filter(Boolean).join(", "), status: 503 };
  const lim = (v, min, max, pad) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : pad; };
  const products = itens.slice(0, 20).map((i, n) => ({
    id: String(i.id || n + 1).slice(0, 20), width: lim(i.largura, 1, 100, 11), height: lim(i.altura, 1, 100, 4), length: lim(i.comprimento, 1, 100, 16),
    weight: lim(i.peso, 0.01, 30, 0.1), insurance_value: Math.round(lim(i.valor, 0, 10000, 0) * 100) / 100, quantity: Math.round(lim(i.qtd, 1, 50, 1)),
  }));
  const base = env.ME_AMBIENTE === "sandbox" ? "https://sandbox.melhorenvio.com.br" : "https://melhorenvio.com.br";
  let r;
  try {
    r = await fetch(`${base}/api/v2/me/shipment/calculate`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": `O Universo Feminino (${contato})` },
      body: JSON.stringify({ from: { postal_code: origem }, to: { postal_code: cep }, products, options: { receipt: false, own_hand: false }, services: "1,2" }),
    });
  } catch { return { erro: "Não foi possível falar com o Melhor Envio.", detalhe: "sem conexão com o Melhor Envio", status: 502 }; }
  const dados = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(dados)) {
    const msg = dados && !Array.isArray(dados) ? String(dados.message || dados.error || "").slice(0, 120) : "";
    return { erro: "O Melhor Envio não retornou o frete.", detalhe: `Melhor Envio respondeu ${r.status}${msg ? ": " + msg : ""}`, status: 502 };
  }
  const opcoes = dados
    .filter((s) => !s.error && /correios/i.test((s.company && s.company.name) || ""))
    .map((s) => ({ id: s.id, nome: s.name, valor: Number(s.custom_price ?? s.price), prazo: Number(s.custom_delivery_time ?? s.delivery_time) }))
    .filter((o) => Number.isFinite(o.valor) && o.valor > 0)
    .sort((a, b) => a.valor - b.valor);
  return { opcoes };
}

export async function consultarCep(cep) {
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const j = await r.json();
    if (j.erro) return { naoExiste: true };
    return { cidade: j.localidade, uf: j.uf, ibge: j.ibge, rua: j.logradouro, bairro: j.bairro };
  } catch { return null; }
}

/* Recalcula tudo no servidor: o cliente só diz o que quer comprar e para onde. */
export async function montarPedido(env, entrada) {
  const itens = [];
  let sub = 0;
  const brutos = Array.isArray(entrada.itens) ? entrada.itens.slice(0, 40) : [];
  for (const b of brutos) {
    const p = CATALOGO.find((x) => x.id === Number(b.id));
    const qtd = Math.min(99, Math.max(1, parseInt(b.qtd) || 1));
    if (!p) continue;
    const ja = itens.find((i) => i.id === p.id);
    if (ja) { ja.qtd = Math.min(99, ja.qtd + qtd); continue; }
    itens.push({ id: p.id, nome: p.nome, preco: p.preco, qtd, peso: p.peso, dim: p.dim });
  }
  if (!itens.length) return { erro: "Sacola vazia.", status: 400 };
  itens.forEach((i) => { sub += i.preco * i.qtd; });
  sub = money(sub);

  const cep = digits(entrada.cep);
  if (cep.length !== 8) return { erro: "Informe um CEP válido para a entrega.", status: 400 };
  let loc = await consultarCep(cep);
  if (loc && loc.naoExiste) return { erro: "CEP não encontrado.", status: 400 };
  if (!loc) {
    const n = Number(cep);
    if (n >= 79600000 && n <= 79649999) loc = { cidade: "Três Lagoas", uf: "MS", ibge: IBGE_TRES_LAGOAS, rua: "", bairro: "" };
    else return { erro: "Não consegui consultar o CEP agora. Tente de novo em instantes.", status: 502 };
  }
  const gratisLocal = loc.ibge === IBGE_TRES_LAGOAS;
  const gratisAcima = FRETE_GRATIS_ACIMA.cidades.some((c) => c[0] === norm(loc.cidade) && c[1] === loc.uf) && sub >= FRETE_GRATIS_ACIMA.valor;
  let frete = 0, freteTxt = "";
  const local = `${loc.cidade} - ${loc.uf}`;
  if (gratisLocal) freteTxt = `Grátis (${local})`;
  else if (gratisAcima) freteTxt = `Grátis (${local}, compras acima de R$ ${FRETE_GRATIS_ACIMA.valor},00)`;
  else {
    const q = await cotarFrete(env, cep, itens.map((i) => ({ id: i.id, qtd: i.qtd, peso: i.peso / 1000, largura: i.dim[0], altura: i.dim[1], comprimento: i.dim[2], valor: i.preco })));
    if (q.erro) return { erro: "Não consegui calcular o frete dos Correios agora. Tente novamente em instantes.", detalhe: q.detalhe, status: 502 };
    if (!q.opcoes.length) return { erro: "Os Correios não atendem este CEP no momento.", status: 400 };
    const o = q.opcoes.find((x) => Number(x.id) === Number(entrada.servicoId)) || q.opcoes[0];
    frete = money(o.valor);
    freteTxt = `Correios ${o.nome} ${local}: R$ ${frete.toFixed(2).replace(".", ",")}, prazo de ${o.prazo} dia(s) úteis`;
  }
  const forma = ["pix", "debito", "credito"].includes(entrada.forma) ? entrada.forma : "pix";
  const parcelas = forma === "credito" ? Math.min(12, Math.max(1, parseInt(entrada.parcelas) || 1)) : 1;
  const { total, taxa } = valorComTaxa(sub + frete, forma, parcelas);
  if (forma === "credito" && parcelas > 1 && total / parcelas < PARCELA_MINIMA) return { erro: "Parcela abaixo do mínimo de R$ 5,00.", status: 400 };
  const rotulo = forma === "pix" ? "Pix" : forma === "debito" ? "Débito" : parcelas === 1 ? "Crédito à vista" : `Crédito em ${parcelas}x`;
  return { itens, sub, frete, freteTxt, total, taxa, forma, parcelas, rotulo, loc, cep };
}

/* ---------- Pix (BR Code estático, copia e cola) ---------- */
function crc16(s) {
  let c = 0xffff;
  for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
  return c.toString(16).toUpperCase().padStart(4, "0");
}
const tlv = (id, v) => id + String(v.length).padStart(2, "0") + v;
const ascii = (s, n) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 ]/g, "").trim().toUpperCase().slice(0, n);
export function payloadPix(env, valor, txid) {
  const chave = String(env.PIX_CHAVE || "").trim();
  if (!chave) return null;
  const conta = tlv("00", "br.gov.bcb.pix") + tlv("01", chave);
  const corpo = tlv("00", "01") + tlv("26", conta) + tlv("52", "0000") + tlv("53", "986") + tlv("54", valor.toFixed(2)) + tlv("58", "BR") +
    tlv("59", ascii(env.PIX_NOME || "O Universo Feminino", 25) || "LOJA") + tlv("60", ascii(env.PIX_CIDADE || "Tres Lagoas", 15) || "BRASIL") +
    tlv("62", tlv("05", String(txid).replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***")) + "6304";
  return corpo + crc16(corpo);
}

/* ---------- InfinitePay ---------- */
export const INFINITEPAY = "https://api.checkout.infinitepay.io";
export async function criarLinkInfinitePay(env, pedido, origem) {
  const handle = String(env.INFINITEPAY_HANDLE || "").replace(/^\$/, "").trim();
  if (!handle) return { erro: "Pagamento por cartão não configurado (falta INFINITEPAY_HANDLE)." };
  let r;
  try {
    r = await fetch(INFINITEPAY + "/links", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle, order_nsu: pedido.numero,
        redirect_url: `${origem}/?pedido=${pedido.numero}`, webhook_url: `${origem}/api/infinitepay`,
        items: [{ quantity: 1, price: Math.round(pedido.total * 100), description: `Pedido ${pedido.numero} - O Universo Feminino` }],
        customer: { name: pedido.nome, email: pedido.email, phone_number: "+55" + pedido.whatsapp },
      }),
    });
  } catch { return { erro: "Não consegui falar com a InfinitePay agora." }; }
  const j = await r.json().catch(() => null);
  const url = j && (j.url || j.link || j.checkout_url || (j.data && (j.data.url || j.data.link)));
  if (!r.ok || !url) return { erro: "A InfinitePay não devolveu o link de pagamento.", detalhe: `status ${r.status}${j ? " campos: " + Object.keys(j).join(",") : ""}` };
  return { url };
}
