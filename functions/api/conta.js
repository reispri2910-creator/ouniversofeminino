// Cloudflare Pages Function: contas de clientes e pedidos feitos dentro da conta.
// Usa o KV PEDIDOS. Variáveis: ADMIN_PASSWORD (ou SESSION_SECRET), PIX_CHAVE, PIX_NOME, PIX_CIDADE, INFINITEPAY_HANDLE, ME_*.
import { json, digits, tel, txt, hashSenha, iguais, criarToken, lerToken, montarPedido, numeroNovo, gravarPedido, lerPedido,
  chavePedido, payloadPix, criarLinkInfinitePay, ETAPAS } from "../_lib.js";

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

function dadosUsuario(u) {
  return { nome: u.nome, email: u.email, tel: u.tel, enderecos: u.enderecos || [], espera: u.espera || [] };
}
function visao(p) {
  return {
    numero: p.numero, criadoEm: p.criadoEm, itens: p.itens.map((i) => ({ id: i.id, nome: i.nome, qtd: i.qtd, preco: i.preco })),
    produtos: p.produtos, frete: p.frete, freteValor: p.freteValor, taxa: p.taxa, total: p.total, forma: p.forma, parcelas: p.parcelas, pagamento: p.pagamento,
    endereco: p.endereco, etapa: p.etapa, datas: p.datas, rastreio: p.rastreio, servico: p.servico, cancelado: !!p.cancelado,
    pago: p.pago === undefined ? true : !!p.pago, linkPagamento: p.linkPagamento || "",
  };
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch { return json({ erro: "Requisição inválida." }, 400); }
  const kv = env.PEDIDOS;
  if (!kv) return json({ erro: "Armazenamento não configurado.", detalhe: "falta o KV com nome PEDIDOS" }, 503);
  if (!env.ADMIN_PASSWORD && !env.SESSION_SECRET) return json({ erro: "Servidor sem ADMIN_PASSWORD configurada." }, 503);
  const origem = new URL(request.url).origin;

  try {
    /* ----- cadastro e login ----- */
    if (b.acao === "cadastrar") {
      const nome = txt(b.nome, 80), email = txt(b.email, 120).toLowerCase(), whats = tel(b.tel), senha = String(b.senha || "");
      if (nome.length < 3) return json({ erro: "Informe seu nome completo." }, 400);
      if (!emailOk(email)) return json({ erro: "Informe um e-mail válido." }, 400);
      if (whats.length < 10) return json({ erro: "Informe o WhatsApp com DDD." }, 400);
      if (senha.length < 6 || senha.length > 100) return json({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);
      if (await kv.get("u:" + email) !== null) return json({ erro: "Este e-mail já tem cadastro. Use a aba Entrar." }, 409);
      const { salt, hash } = await hashSenha(senha);
      const u = { nome, email, tel: whats, salt, hash, enderecos: [], espera: [], pedidos: [], criadoEm: new Date().toISOString() };
      await kv.put("u:" + email, JSON.stringify(u));
      return json({ token: await criarToken(env, email), usuario: dadosUsuario(u) });
    }
    if (b.acao === "entrar") {
      const email = txt(b.email, 120).toLowerCase();
      const u = emailOk(email) ? await kv.get("u:" + email, "json") : null;
      const h = u ? await hashSenha(String(b.senha || ""), u.salt) : null;
      if (!u || !iguais(unhex(h.hash), unhex(u.hash))) return json({ erro: "E-mail ou senha incorretos." }, 401);
      return json({ token: await criarToken(env, email), usuario: dadosUsuario(u) });
    }

    /* ----- daqui para baixo, só com login ----- */
    const email = await lerToken(env, b.token);
    const u = email ? await kv.get("u:" + email, "json") : null;
    if (!u) return json({ erro: "Sua sessão expirou. Entre novamente.", sessao: false }, 401);
    const salvar = () => kv.put("u:" + email, JSON.stringify(u));

    if (b.acao === "eu") return json({ usuario: dadosUsuario(u) });

    if (b.acao === "atualizar") {
      if (b.nome !== undefined) { const n = txt(b.nome, 80); if (n.length < 3) return json({ erro: "Informe seu nome completo." }, 400); u.nome = n; }
      if (b.tel !== undefined) { const t = tel(b.tel); if (t.length < 10) return json({ erro: "Informe o WhatsApp com DDD." }, 400); u.tel = t; }
      if (Array.isArray(b.enderecos)) u.enderecos = b.enderecos.slice(0, 10).map((a) => ({
        apelido: txt(a.apelido, 30), cep: digits(a.cep).slice(0, 8), rua: txt(a.rua, 100), numero: txt(a.numero, 15), complemento: txt(a.complemento, 40),
        bairro: txt(a.bairro, 50), cidade: txt(a.cidade, 50), uf: txt(a.uf, 2).toUpperCase(),
      })).filter((a) => a.rua && a.cep.length === 8);
      if (Array.isArray(b.espera)) u.espera = b.espera.slice(0, 50).map(Number).filter(Number.isFinite);
      await salvar();
      return json({ usuario: dadosUsuario(u) });
    }

    if (b.acao === "senha") {
      const h = await hashSenha(String(b.atual || ""), u.salt);
      if (!iguais(unhex(h.hash), unhex(u.hash))) return json({ erro: "A senha atual está incorreta." }, 401);
      const nova = String(b.nova || "");
      if (nova.length < 6 || nova.length > 100) return json({ erro: "A nova senha precisa ter pelo menos 6 caracteres." }, 400);
      Object.assign(u, await hashSenha(nova));
      await salvar();
      return json({ ok: true });
    }

    if (b.acao === "pedido") {
      const p = await lerPedido(kv, b.numero);
      if (!p || p.email !== email) return json({ erro: "Pedido não encontrado." }, 404);
      return json({ pedido: visao(p), etapas: ETAPAS });
    }

    if (b.acao === "meus_pedidos") {
      // junta pedidos antigos feitos com o mesmo WhatsApp (feitos antes do cadastro obrigatório)
      const { keys } = await kv.list({ limit: 1000 });
      const antigos = keys.map((k) => k.name).filter((n) => /^\d+$/.test(n) && !(u.pedidos || []).includes(n)).sort().slice(-15);
      let mudou = false;
      for (const n of antigos) {
        const p = await kv.get(n, "json");
        if (p && p.whatsapp === u.tel && !p.email) { u.pedidos = [...(u.pedidos || []), n]; mudou = true; }
      }
      if (mudou) await salvar();
      const nums = (u.pedidos || []).slice(-20);
      const lista = (await Promise.all(nums.map((n) => lerPedido(kv, n)))).filter(Boolean);
      lista.sort((x, y) => (y.criadoEm || "").localeCompare(x.criadoEm || ""));
      return json({ pedidos: lista.map(visao), etapas: ETAPAS });
    }

    if (b.acao === "criar_pedido") {
      const e = b.endereco || {};
      const end = { cep: digits(e.cep).slice(0, 8), rua: txt(e.rua, 100), numero: txt(e.numero, 15), complemento: txt(e.complemento, 40), bairro: txt(e.bairro, 50) };
      if (end.cep.length !== 8 || !end.rua || !end.numero || !end.bairro) return json({ erro: "Preencha CEP, rua, número e bairro da entrega." }, 400);
      const m = await montarPedido(env, { itens: b.itens, cep: end.cep, servicoId: b.servicoId, forma: b.forma, parcelas: b.parcelas });
      if (m.erro) return json({ erro: m.erro, detalhe: m.detalhe }, m.status || 400);
      const agora = new Date().toISOString();
      const enderecoTxt = `${end.rua}, ${end.numero}${end.complemento ? " - " + end.complemento : ""}, ${end.bairro}, ${m.loc.cidade} - ${m.loc.uf}, CEP ${end.cep.slice(0, 5)}-${end.cep.slice(5)}`;
      const pedido = {
        email, nome: u.nome, whatsapp: u.tel,
        itens: m.itens.map((i) => ({ id: i.id, nome: i.nome, qtd: i.qtd, preco: i.preco })),
        produtos: m.sub, frete: m.freteTxt, freteValor: m.frete, taxa: m.taxa, total: m.total, forma: m.forma, parcelas: m.parcelas, pagamento: m.rotulo,
        endereco: enderecoTxt, criadoEm: agora, etapa: 1, datas: { 1: agora }, rastreio: "", servico: "", cancelado: false, pago: false,
      };
      let ok = false;
      for (let t = 0; t < 6; t++) {
        pedido.numero = numeroNovo();
        if ((await kv.get(chavePedido(pedido.numero))) === null && (await kv.get(pedido.numero)) === null) { await kv.put(chavePedido(pedido.numero), JSON.stringify(pedido)); ok = true; break; }
      }
      if (!ok) return json({ erro: "Não foi possível criar o pedido." }, 500);
      u.pedidos = [...(u.pedidos || []), pedido.numero].slice(-100);
      await salvar();
      return json({ pedido: visao(pedido) });
    }

    if (b.acao === "pagar") {
      const p = await lerPedido(kv, b.numero);
      if (!p || p.email !== email) return json({ erro: "Pedido não encontrado." }, 404);
      if (p.cancelado) return json({ erro: "Este pedido foi cancelado." }, 400);
      if (p.pago) return json({ pago: true });
      if (p.forma === "pix") {
        const codigo = payloadPix(env, p.total, p.numero);
        if (!codigo) return json({ erro: "Pix ainda não configurado na loja (falta PIX_CHAVE). Fale com a gente no WhatsApp." }, 503);
        return json({ pix: codigo, total: p.total });
      }
      if (!p.linkPagamento) {
        const r = await criarLinkInfinitePay(env, p, origem);
        if (r.erro) return json({ erro: r.erro, detalhe: r.detalhe }, 502);
        p.linkPagamento = r.url;
        await gravarPedido(kv, p);
      }
      return json({ link: p.linkPagamento, total: p.total });
    }
    return json({ erro: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("conta:", e && e.message);
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
}
export const onRequest = () => json({ erro: "Método não permitido." }, 405);
