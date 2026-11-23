// Cloudflare Pages Function: pedidos (criar, rastrear, administrar).
// Precisa do KV com o nome de variável PEDIDOS e da variável secreta ADMIN_PASSWORD.

const ETAPAS = ["Pedido realizado", "Pagamento confirmado", "Aguardando envio", "Enviado", "Entregue"];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const digits = (s) => String(s || "").replace(/\D/g, "");
const tel = (s) => { const d = digits(s); return d.length > 11 ? d.slice(-11) : d; };
const txt = (s, n) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, n);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };

async function sha(s) { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)))); }
async function senhaOk(env, senha) {
  const real = env.ADMIN_PASSWORD;
  if (!real || real.length < 6 || typeof senha !== "string") return false;
  const a = await sha(senha), b = await sha(real);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function publico(p) {
  return {
    numero: p.numero, criadoEm: p.criadoEm, nome: p.nome, itens: p.itens, produtos: p.produtos,
    frete: p.frete, total: p.total, pagamento: p.pagamento, endereco: p.endereco,
    etapa: p.etapa, datas: p.datas, rastreio: p.rastreio, servico: p.servico, cancelado: !!p.cancelado,
  };
}

function numeroNovo() {
  const d = new Date(Date.now() - 3 * 3600 * 1000); // horário de Mato Grosso do Sul
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, "");
  return ymd + String(Math.floor(10000 + Math.random() * 90000));
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const kv = env.PEDIDOS;
  if (!kv) return json({ erro: "Armazenamento de pedidos não configurado.", detalhe: "falta o KV com nome PEDIDOS" }, 503);

  try {
    if (b.acao === "criar") {
      const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 40).map((i) => ({
        nome: txt(i.nome, 120), qtd: Math.min(99, Math.max(1, parseInt(i.qtd) || 1)), preco: num(i.preco),
      })).filter((i) => i.nome);
      const whats = tel(b.whatsapp);
      if (!itens.length) return json({ erro: "Pedido sem itens." }, 400);
      if (whats.length < 10) return json({ erro: "Informe um WhatsApp válido." }, 400);
      const agora = new Date().toISOString();
      const pedido = {
        nome: txt(b.nome, 80), whatsapp: whats, itens,
        produtos: num(b.produtos), frete: txt(b.frete, 160), total: num(b.total), pagamento: txt(b.pagamento, 120),
        endereco: txt(b.endereco, 200), criadoEm: agora,
        etapa: 1, datas: { 1: agora }, rastreio: "", servico: "", cancelado: false,
      };
      for (let t = 0; t < 6; t++) {
        pedido.numero = numeroNovo();
        if (await kv.get(pedido.numero) === null) {
          await kv.put(pedido.numero, JSON.stringify(pedido));
          return json({ numero: pedido.numero });
        }
      }
      return json({ erro: "Não foi possível criar o pedido." }, 500);
    }

    if (b.acao === "rastrear") {
      const numero = digits(b.numero);
      const p = numero ? await kv.get(numero, "json") : null;
      if (!p || tel(b.whatsapp) !== p.whatsapp) return json({ erro: "Pedido não encontrado. Confira o número e o WhatsApp usado na compra." }, 404);
      return json({ pedido: publico(p), etapas: ETAPAS });
    }

    if (b.acao === "admin_listar" || b.acao === "admin_atualizar") {
      if (!(await senhaOk(env, b.senha))) return json({ erro: "Senha incorreta ou ADMIN_PASSWORD não configurada." }, 401);

      if (b.acao === "admin_listar") {
        const { keys } = await kv.list({ limit: 1000 });
        const recentes = keys.map((k) => k.name).sort().slice(-40).reverse();
        const todos = (await Promise.all(recentes.map((k) => kv.get(k, "json")))).filter(Boolean);
        todos.sort((a, c) => (c.criadoEm || "").localeCompare(a.criadoEm || ""));
        return json({ pedidos: todos, etapas: ETAPAS });
      }

      const numero = digits(b.numero);
      const p = numero ? await kv.get(numero, "json") : null;
      if (!p) return json({ erro: "Pedido não encontrado." }, 404);
      if (b.etapa !== undefined) {
        const e = parseInt(b.etapa);
        if (e >= 1 && e <= 5) {
          p.etapa = e;
          p.datas = p.datas || {};
          for (let i = 1; i <= e; i++) if (!p.datas[i]) p.datas[i] = new Date().toISOString();
          for (let i = e + 1; i <= 5; i++) delete p.datas[i];
        }
      }
      if (b.rastreio !== undefined) p.rastreio = txt(b.rastreio, 40).toUpperCase();
      if (b.servico !== undefined) p.servico = txt(b.servico, 20);
      if (b.cancelado !== undefined) p.cancelado = !!b.cancelado;
      await kv.put(numero, JSON.stringify(p));
      return json({ pedido: p });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("pedidos:", e && e.message);
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
}

export const onRequest = () => json({ erro: "Método não permitido." }, 405);
