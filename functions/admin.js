// Cloudflare Pages Function: painel da loja (estoque, clientes e envio pelos Correios via Melhor Envio).
// Toda ação exige a senha do admin (ADMIN_PASSWORD).
// Para o envio, o token do Melhor Envio precisa das permissões: cart-write, shipping-checkout, shipping-generate, shipping-print, shipping-tracking.
// Variáveis do remetente: ME_REM_NOME, ME_REM_DOC, ME_REM_TEL, ME_REM_EMAIL, ME_REM_RUA, ME_REM_NUM, ME_REM_BAIRRO, ME_REM_CIDADE, ME_REM_UF (e opcional ME_REM_COMPL). O CEP vem de ORIGEM_CEP.
import { CATALOGO } from "../_catalogo.js";
import { json, digits, txt, senhaAdminOk, lerPedido, gravarPedido, lerEstoque } from "../_lib.js";

const meBase = (env) => (env.ME_AMBIENTE === "sandbox" ? "https://sandbox.melhorenvio.com.br" : "https://melhorenvio.com.br");
async function me(env, metodo, caminho, corpo) {
  const r = await fetch(meBase(env) + "/api/v2/me" + caminho, {
    method: metodo,
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${env.ME_TOKEN}`, "User-Agent": `O Universo Feminino (${env.ME_CONTATO})` },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const bruto = await r.text(); let j = null; try { j = JSON.parse(bruto); } catch {}
  return { ok: r.ok, status: r.status, j, bruto };
}
const falhaME = (r, etapa) => {
  let msg = "";
  if (r.j) { msg = r.j.message || r.j.error || ""; if (r.j.errors) msg += " " + JSON.stringify(r.j.errors); }
  return json({ erro: `O Melhor Envio recusou (${etapa}).`, detalhe: `status ${r.status}: ${String(msg || r.bruto).replace(/\s+/g, " ").slice(0, 300)}` }, 502);
};

function remetente(env) {
  const f = { nome: env.ME_REM_NOME, doc: digits(env.ME_REM_DOC), tel: digits(env.ME_REM_TEL), email: env.ME_REM_EMAIL, rua: env.ME_REM_RUA, num: env.ME_REM_NUM, bairro: env.ME_REM_BAIRRO, cidade: env.ME_REM_CIDADE, uf: env.ME_REM_UF, cep: digits(env.ORIGEM_CEP) };
  const falta = [["ME_REM_NOME", f.nome], ["ME_REM_DOC", f.doc], ["ME_REM_TEL", f.tel], ["ME_REM_EMAIL", f.email], ["ME_REM_RUA", f.rua], ["ME_REM_NUM", f.num], ["ME_REM_BAIRRO", f.bairro], ["ME_REM_CIDADE", f.cidade], ["ME_REM_UF", f.uf]].filter(([, v]) => !v).map(([k]) => k);
  return { f, falta };
}

function montarCarrinho(env, p, servico, cpf) {
  const { f } = remetente(env);
  const e = p.entrega;
  const itens = p.itens.map((i) => ({ i, c: CATALOGO.find((x) => x.id === i.id) || { peso: 100, dim: [11, 4, 16] } }));
  const peso = itens.reduce((t, { i, c }) => t + (c.peso / 1000) * i.qtd, 0);
  const volume = {
    width: Math.max(...itens.map(({ c }) => c.dim[0])), length: Math.max(...itens.map(({ c }) => c.dim[2])),
    height: Math.min(100, Math.max(2, Math.ceil(itens.reduce((t, { i, c }) => t + c.dim[1] * i.qtd, 0)))), weight: Math.max(0.1, Math.round(peso * 1000) / 1000),
  };
  const doc = f.doc;
  return {
    service: servico,
    from: {
      name: f.nome, phone: f.tel, email: f.email, ...(doc.length > 11 ? { company_document: doc } : { document: doc }),
      address: f.rua, complement: env.ME_REM_COMPL || "", number: f.num, district: f.bairro, city: f.cidade, country_id: "BR", postal_code: f.cep, state_abbr: String(f.uf).toUpperCase(),
    },
    to: {
      name: p.nome, phone: digits(p.whatsapp), email: p.email || "sem-email@ouniversofeminino.com.br", ...(cpf ? { document: cpf } : {}),
      address: e.rua, complement: e.complemento || "", number: e.numero, district: e.bairro, city: e.cidade, country_id: "BR", postal_code: e.cep, state_abbr: e.uf,
    },
    products: p.itens.map((i) => ({ name: i.nome.slice(0, 100), quantity: i.qtd, unitary_value: i.preco })),
    volumes: [volume],
    options: { insurance_value: p.produtos, receipt: false, own_hand: false, reverse: false, non_commercial: true },
  };
}

export async function onRequestPost({ request, env }) {
  let b; try { b = await request.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const kv = env.PEDIDOS;
  if (!kv) return json({ erro: "Armazenamento não configurado." }, 503);
  if (!(await senhaAdminOk(env, b.senha))) return json({ erro: "Senha incorreta ou ADMIN_PASSWORD não configurada." }, 401);
  try {
    /* ----- estoque ----- */
    if (b.acao === "estoque_ler") {
      const est = await lerEstoque(kv);
      return json({ produtos: CATALOGO.map((c) => ({ id: c.id, nome: c.nome, controla: !!est[c.id], qtd: est[c.id]?.qtd ?? 0, min: est[c.id]?.min ?? 0 })) });
    }
    if (b.acao === "estoque_salvar") {
      const id = Number(b.id);
      if (!CATALOGO.some((c) => c.id === id)) return json({ erro: "Produto inexistente." }, 404);
      const est = await lerEstoque(kv);
      if (b.controla === false) delete est[id];
      else est[id] = { qtd: Math.max(0, Math.min(99999, parseInt(b.qtd) || 0)), min: Math.max(0, Math.min(99999, parseInt(b.min) || 0)) };
      await kv.put("estoque", JSON.stringify(est));
      return json({ ok: true });
    }

    /* ----- clientes (CRM) ----- */
    if (b.acao === "clientes") {
      const { keys } = await kv.list({ prefix: "u:", limit: 1000 });
      const nomes = keys.map((k) => k.name).slice(-45);
      const lista = (await Promise.all(nomes.map((k) => kv.get(k, "json")))).filter(Boolean);
      return json({ total: keys.length, clientes: lista.map((u) => ({ nome: u.nome, email: u.email, tel: u.tel, criadoEm: u.criadoEm, espera: u.espera || [], pedidos: (u.pedidos || []).length })) });
    }

    /* ----- envio pelos Correios ----- */
    if (b.acao === "envio_preparar" || b.acao === "envio_confirmar" || b.acao === "envio_desfazer") {
      if (!env.ME_TOKEN) return json({ erro: "ME_TOKEN não configurado." }, 503);
      const p = await lerPedido(kv, b.numero);
      if (!p) return json({ erro: "Pedido não encontrado." }, 404);

      if (b.acao === "envio_preparar") {
        if (p.cancelado) return json({ erro: "Pedido cancelado." }, 400);
        if (!p.pago) return json({ erro: "O pagamento deste pedido ainda não foi confirmado." }, 400);
        if (p.envio && p.envio.estado === "comprado") return json({ erro: "O envio deste pedido já foi comprado." }, 400);
        if (!p.entrega) return json({ erro: "Pedido antigo, sem endereço completo. Crie a etiqueta direto no painel do Melhor Envio." }, 400);
        const { falta } = remetente(env);
        if (falta.length) return json({ erro: "Faltam dados do remetente nas variáveis da Cloudflare.", detalhe: falta.join(", ") }, 503);
        const servico = [1, 2].includes(Number(b.servicoId)) ? Number(b.servicoId) : [1, 2].includes(Number(p.servicoId)) ? Number(p.servicoId) : 1;
        const cpf = digits(b.cpf);
        if (p.envio && p.envio.cartId) await me(env, "DELETE", `/cart/${p.envio.cartId}`); // refaz o carrinho se já havia um
        const r = await me(env, "POST", "/cart", montarCarrinho(env, p, servico, cpf.length === 11 ? cpf : ""));
        if (!r.ok || !r.j || !r.j.id) return falhaME(r, "colocar no carrinho");
        p.envio = { estado: "no_carrinho", cartId: r.j.id, servico, preco: Number(r.j.price ?? 0), protocolo: r.j.protocol || "" };
        await gravarPedido(kv, p);
        return json({ envio: p.envio });
      }

      if (!p.envio || !p.envio.cartId) return json({ erro: "Este pedido ainda não foi preparado para envio." }, 400);

      if (b.acao === "envio_desfazer") {
        if (p.envio.estado === "comprado") return json({ erro: "A etiqueta já foi comprada. Cancele pelo painel do Melhor Envio." }, 400);
        await me(env, "DELETE", `/cart/${p.envio.cartId}`);
        delete p.envio; await gravarPedido(kv, p);
        return json({ ok: true });
      }

      // envio_confirmar: AQUI o saldo do Melhor Envio é usado
      if (p.envio.estado !== "comprado") {
        const c = await me(env, "POST", "/shipment/checkout", { orders: [p.envio.cartId] });
        if (!c.ok) return falhaME(c, "pagar a etiqueta (confira o saldo)");
        p.envio.estado = "comprado"; await gravarPedido(kv, p);
      }
      const g = await me(env, "POST", "/shipment/generate", { orders: [p.envio.cartId] });
      if (!g.ok) { return falhaME(g, "gerar a etiqueta (a compra já foi feita, tente de novo)"); }
      const t = await me(env, "POST", "/shipment/tracking", { orders: [p.envio.cartId] });
      const info = t.ok && t.j ? t.j[p.envio.cartId] : null;
      const codigo = info && (info.tracking || info.melhorenvio_tracking) || "";
      const pr = await me(env, "POST", "/shipment/print", { mode: "private", orders: [p.envio.cartId] });
      p.envio.etiqueta = (pr.ok && pr.j && pr.j.url) || "";
      if (codigo) p.rastreio = String(codigo).toUpperCase();
      p.servico = p.envio.servico === 2 ? "SEDEX" : "PAC";
      if (p.etapa < 3) { p.etapa = 3; p.datas = p.datas || {}; p.datas[3] = new Date().toISOString(); }
      await gravarPedido(kv, p);
      return json({ envio: p.envio, rastreio: p.rastreio, pedido: p });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("admin:", e && e.message);
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
}
export const onRequest = () => json({ erro: "Método não permitido." }, 405);
