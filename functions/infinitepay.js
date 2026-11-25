// Cloudflare Pages Function: aviso (webhook) da InfinitePay quando um pagamento é aprovado.
// Não confiamos no aviso: conferimos o pagamento na própria InfinitePay antes de marcar como pago.
import { json, lerPedido, gravarPedido, baixarEstoque, INFINITEPAY } from "../_lib.js";

export async function onRequestPost({ request, env }) {
  const kv = env.PEDIDOS, handle = String(env.INFINITEPAY_HANDLE || "").replace(/^\$/, "").trim();
  if (!kv || !handle) return json({ erro: "não configurado" }, 503);
  let b; try { b = await request.json(); } catch { return json({ erro: "inválido" }, 400); }
  const p = await lerPedido(kv, b.order_nsu);
  if (!p || p.forma === "pix") return json({ erro: "pedido não encontrado" }, 400);
  if (p.pago) return json({ ok: true });
  let c;
  try {
    const r = await fetch(INFINITEPAY + "/payment_check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, order_nsu: p.numero, transaction_nsu: b.transaction_nsu, slug: b.invoice_slug }),
    });
    c = await r.json();
  } catch { return json({ erro: "falha ao conferir" }, 400); } // a InfinitePay tenta de novo
  const esperado = Math.round(p.total * 100);
  if (!c || !c.success || !c.paid || Number(c.amount) < esperado) return json({ erro: "pagamento não confirmado" }, 400);
  const agora = new Date().toISOString();
  p.pago = true; p.pagoEm = agora; p.transacao = String(b.transaction_nsu || "").slice(0, 60);
  p.pagoValor = Number(c.paid_amount || c.amount) / 100; p.parcelasPagas = Number(c.installments) || 1;
  if (p.etapa < 2) { p.etapa = 2; p.datas = p.datas || {}; p.datas[2] = agora; }
  await baixarEstoque(kv, p);
  await gravarPedido(kv, p);
  return json({ ok: true });
}
export const onRequest = () => json({ erro: "Use POST." }, 405);
