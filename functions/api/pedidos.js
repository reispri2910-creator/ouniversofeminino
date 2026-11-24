// Cloudflare Pages Function: rastrear pedido (cliente) e administrar pedidos (loja).
// Precisa do KV PEDIDOS e da variável secreta ADMIN_PASSWORD.
import { json, digits, tel, txt, ETAPAS, senhaAdminOk, lerPedido, gravarPedido } from "../_lib.js";

function publico(p) {
  return {
    numero: p.numero, criadoEm: p.criadoEm, nome: p.nome, itens: p.itens, produtos: p.produtos,
    frete: p.frete, total: p.total, pagamento: p.pagamento, endereco: p.endereco,
    etapa: p.etapa, datas: p.datas, rastreio: p.rastreio, servico: p.servico, cancelado: !!p.cancelado, pago: !!p.pago,
  };
}
const ehPedido = (k) => /^(p:)?\d+$/.test(k);

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const kv = env.PEDIDOS;
  if (!kv) return json({ erro: "Armazenamento de pedidos não configurado.", detalhe: "falta o KV com nome PEDIDOS" }, 503);
  try {
    if (b.acao === "rastrear") {
      const p = await lerPedido(kv, b.numero);
      if (!p || tel(b.whatsapp) !== p.whatsapp) return json({ erro: "Pedido não encontrado. Confira o número e o WhatsApp usado na compra." }, 404);
      return json({ pedido: publico(p), etapas: ETAPAS });
    }
    if (b.acao === "admin_listar" || b.acao === "admin_atualizar") {
      if (!(await senhaAdminOk(env, b.senha))) return json({ erro: "Senha incorreta ou ADMIN_PASSWORD não configurada." }, 401);
      if (b.acao === "admin_listar") {
        const { keys } = await kv.list({ limit: 1000 });
        const recentes = keys.map((k) => k.name).filter(ehPedido).sort((a, c) => a.replace("p:", "").localeCompare(c.replace("p:", ""))).slice(-40).reverse();
        const todos = (await Promise.all(recentes.map((k) => kv.get(k, "json")))).filter(Boolean);
        todos.sort((a, c) => (c.criadoEm || "").localeCompare(a.criadoEm || ""));
        return json({ pedidos: todos, etapas: ETAPAS });
      }
      const p = await lerPedido(kv, b.numero);
      if (!p) return json({ erro: "Pedido não encontrado." }, 404);
      if (b.etapa !== undefined) {
        const e = parseInt(b.etapa);
        if (e >= 1 && e <= 5) {
          p.etapa = e; p.datas = p.datas || {};
          for (let i = 1; i <= e; i++) if (!p.datas[i]) p.datas[i] = new Date().toISOString();
          for (let i = e + 1; i <= 5; i++) delete p.datas[i];
          if (e >= 2) p.pago = true;
        }
      }
      if (b.rastreio !== undefined) p.rastreio = txt(b.rastreio, 40).toUpperCase();
      if (b.servico !== undefined) p.servico = txt(b.servico, 20);
      if (b.cancelado !== undefined) p.cancelado = !!b.cancelado;
      await gravarPedido(kv, p);
      return json({ pedido: p });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("pedidos:", e && e.message);
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
}
export const onRequest = () => json({ erro: "Método não permitido." }, 405);
