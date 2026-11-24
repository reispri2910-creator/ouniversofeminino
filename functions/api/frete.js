// Cloudflare Pages Function: consulta o frete dos Correios (PAC e SEDEX) pelo Melhor Envio.
// Variáveis: ME_TOKEN, ORIGEM_CEP, ME_CONTATO (e opcional ME_AMBIENTE = sandbox)
import { json, digits, cotarFrete } from "../_lib.js";

export async function onRequestPost({ request, env }) {
  let corpo;
  try { corpo = await request.json(); } catch { return json({ erro: "Pedido inválido." }, 400); }
  const cep = digits(corpo.cep);
  if (cep.length !== 8) return json({ erro: "CEP inválido." }, 400);
  const itens = Array.isArray(corpo.itens) ? corpo.itens.slice(0, 20) : [];
  if (!itens.length) return json({ erro: "Sacola vazia." }, 400);
  const r = await cotarFrete(env, cep, itens);
  if (r.erro) return json({ erro: r.erro, detalhe: r.detalhe }, r.status || 502);
  return json({ opcoes: r.opcoes });
}
export const onRequest = () => json({ erro: "Use POST." }, 405);
