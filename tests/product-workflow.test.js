// FASE 3 — Product Domain + Editor Workflow — Tests de integracion contra una
// base de datos REAL de prueba (misma estrategia que tests/integration-s4.test.js,
// en un archivo aparte para no inflar esa suite ni pisar su fixture).
//
// Usa una base de datos APARTE: `db-dusck-workflow-test`, que se elimina al
// empezar y al terminar. NO toca `db-dusck` ni `db-dusck-s4-test`.
//
// Si no hay MongoDB disponible, la suite entera se marca `skip` (no falla).
//
// Ejecutar:  npm test        (o)   node --test tests/product-workflow.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-workflow-test";
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null;
let mongoAvailable = true;

test.before(async () => {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();

    const app = (await import("../src/app.js")).default;
    const { encryptedPassword } = await import("../src/helpers/bycryp.helper.js");
    const { generateToken } = await import("../src/helpers/jwt.helpers.js");
    const UserModel = (await import("../src/models/user.model.js")).default;
    const CategoryModel = (await import("../src/models/category.model.js")).default;
    const ProductModel = (await import("../src/models/product.model.js")).default;
    const { PRODUCT_STATUS } = await import("../src/helpers/productWorkflow.helper.js");

    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]);

    const makeUser = async (over) => {
      const doc = await UserModel.create({
        password: encryptedPassword("Secret123"),
        status: true,
        ...over,
      });
      const token = generateToken({
        _id: doc._id,
        name: doc.name,
        email: doc.email,
        nickname: doc.nickname,
        role: doc.role,
      });
      return { doc, token };
    };

    const admin = await makeUser({
      name: "Admin WF",
      nickname: "admin-wf",
      email: "admin-wf@dusck.com",
      role: "administrador",
    });
    const editorA = await makeUser({
      name: "Editor A WF",
      nickname: "editor-a-wf",
      email: "editor-a-wf@dusck.com",
      role: "editor",
    });
    const editorB = await makeUser({
      name: "Editor B WF",
      nickname: "editor-b-wf",
      email: "editor-b-wf@dusck.com",
      role: "editor",
    });
    const shopManager = await makeUser({
      name: "Shop Manager WF",
      nickname: "shopmgr-wf",
      email: "shopmgr-wf@dusck.com",
      role: "shop_manager",
    });
    const subscriber = await makeUser({
      name: "Subscriber WF",
      nickname: "sub-wf",
      email: "sub-wf@dusck.com",
      role: "subscriber",
    });

    const catHombre = await CategoryModel.create({ name: "Hombre WF", slug: "hombre-wf" });
    const catCamisetas = await CategoryModel.create({ name: "Camisetas WF", slug: "camisetas-wf" });
    const catSuelta = await CategoryModel.create({ name: "Suelta WF", slug: "suelta-wf" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      PRODUCT_STATUS,
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, editorA, editorB, shopManager, subscriber },
      categories: { hombre: catHombre, camisetas: catCamisetas, suelta: catSuelta },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[product-workflow] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.after(async () => {
  if (ctx) {
    await ctx.mongoose.connection.dropDatabase();
    await ctx.mongoose.disconnect();
    await new Promise((r) => ctx.server.close(r));
  }
});

const api = (path, { method = "GET", body, token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// Helper: producto minimo pero VALIDO para pasar submit-review (sin variantes).
// `categories` por defecto trae UNA categoria real (collectSubmitReviewErrors
// exige al menos 1): usar `categories: []` explicito en el override cuando un
// test quiera probar justo la ausencia de categoria.
const validDraftPayload = (overrides = {}) => ({
  name: "Producto WF valido",
  slug: `producto-wf-valido-${Math.random().toString(36).slice(2, 8)}`,
  description: "Descripcion suficiente para pasar revision.",
  price: 50000,
  stock: 5,
  // FASE 1 — obligatorios para ENVIAR A REVISION (no para guardar borrador).
  details: "Composicion 100% algodon peinado. Lavar a mano.",
  shippingInfo: "Envio nacional 2-4 dias habiles.",
  returnsInfo: "Cambios dentro de 30 dias con etiqueta.",
  // `hombre` (nunca se borra en ningun test); `suelta` se usa solo en el test
  // de "categoria en uso" y termina eliminada, no sirve como default estable.
  categories: [ctx.categories.hombre._id.toString()],
  images: [{ url: "http://dusck.test/wf.png", isMain: true }],
  ...overrides,
});

// ---------------------------------------------------------------------------
// CATEGORÍAS MÚLTIPLES
// ---------------------------------------------------------------------------

test("categorias multiples: un producto se crea con 2 categorias y las conserva", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { hombre, camisetas } = ctx.categories;

  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ categories: [hombre._id.toString(), camisetas._id.toString()] }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.categories.length, 2);
});

test("categoria inexistente -> 400 (no se guarda una referencia rota)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();

  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ categories: [fakeId] }),
  });
  assert.equal(res.status, 400);
});

test("categoria en uso NO se puede eliminar (409); se libera y entonces si", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { suelta } = ctx.categories;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ categories: [suelta._id.toString()] }),
  });
  const { data: product } = await created.json();

  // el guard de "categoria en uso" se prueba con admin (el editor ni siquiera
  // tiene autorizacion de ruta para DELETE /category):
  const blockedAsAdmin = await api(`/api/category/${suelta._id}`, {
    method: "DELETE",
    token: ctx.users.admin.token,
  });
  assert.equal(blockedAsAdmin.status, 409);

  // liberamos la categoria (quitamos la referencia) y confirmamos que ahora si se puede
  await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { categories: [] },
  });
  const freed = await api(`/api/category/${suelta._id}`, {
    method: "DELETE",
    token: ctx.users.admin.token,
  });
  assert.equal(freed.status, 200);
});

// ---------------------------------------------------------------------------
// SKU: unicidad local (mismo producto), global (otro producto), create + update
// ---------------------------------------------------------------------------

test("SKU duplicado DENTRO del mismo producto (creacion) -> 409", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;

  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({
      variants: [
        { sku: "DUS-WF-DUP", color: "Negro", size: "S", stock: 1 },
        { sku: "DUS-WF-DUP", color: "Blanco", size: "M", stock: 2 },
      ],
    }),
  });
  assert.equal(res.status, 409);
});

test("SKU duplicado ENTRE productos distintos (creacion) -> 409", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;

  const first = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ variants: [{ sku: "DUS-WF-GLOBAL-1", color: "Negro", size: "Única", stock: 1 }] }),
  });
  assert.equal(first.status, 200);

  const second = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ variants: [{ sku: "DUS-WF-GLOBAL-1", color: "Azul", size: "Única", stock: 4 }] }),
  });
  assert.equal(second.status, 409);
});

test("SKU duplicado contra otro producto EN UNA ACTUALIZACION -> 409", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;

  const a = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ variants: [{ sku: "DUS-WF-UPD-A", color: "Negro", size: "Única", stock: 1 }] }),
  });
  const { data: productA } = await a.json();

  await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ variants: [{ sku: "DUS-WF-UPD-B", color: "Negro", size: "Única", stock: 1 }] }),
  });

  // intenta renombrar el SKU de A para que choque con el de B
  const res = await api(`/api/product/${productA._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { variants: [{ sku: "DUS-WF-UPD-B", color: "Negro", size: "Única", stock: 1 }] },
  });
  assert.equal(res.status, 409);
});

test("stock derivado: Product.stock = suma de variants.stock (crear y actualizar)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({
      variants: [
        { sku: `DUS-WF-STOCK-${Date.now()}-S`, color: "Negro", size: "S", stock: 3 },
        { sku: `DUS-WF-STOCK-${Date.now()}-M`, color: "Negro", size: "M", stock: 5 },
      ],
    }),
  });
  const { data: product } = await created.json();
  assert.equal(product.stock, 8);

  const updated = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: {
      variants: [
        { sku: `DUS-WF-STOCK-${Date.now()}-S2`, color: "Negro", size: "S", stock: 1 },
        { sku: `DUS-WF-STOCK-${Date.now()}-M2`, color: "Negro", size: "M", stock: 1 },
        { sku: `DUS-WF-STOCK-${Date.now()}-L2`, color: "Negro", size: "L", stock: 1 },
      ],
    },
  });
  const { data: after } = await updated.json();
  assert.equal(after.stock, 3);
});

// ---------------------------------------------------------------------------
// SUBMIT REVIEW: validacion minima
// ---------------------------------------------------------------------------

test("DRAFT incompleto -> submit-review 400 con lista de errores", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: { name: "Solo nombre", slug: `solo-nombre-${Date.now()}` }, // sin precio/imagenes/categorias
  });
  const { data: product } = await created.json();

  const res = await api(`/api/product/${product._id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "PENDING_REVIEW" },
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(Array.isArray(json.errors) && json.errors.length > 0);
});

// ---------------------------------------------------------------------------
// FLUJO FELIZ COMPLETO + visibilidad publica
// ---------------------------------------------------------------------------

test("flujo feliz: DRAFT -> PENDING_REVIEW -> APPROVED -> PUBLISHED, visible solo al final", async (t) => {
  if (guard(t)) return;
  const { editorA, admin, shopManager } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload({ categories: [ctx.categories.hombre._id.toString()] }),
  });
  const { data: product } = await created.json();
  const id = product._id;

  // Publico: NO existe todavia (DRAFT)
  const draftPublic = await api(`/api/product/${id}`);
  assert.equal(draftPublic.status, 404);

  // editor envia a revision
  const submit = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "PENDING_REVIEW" },
  });
  assert.equal(submit.status, 200);

  // admin ve la cola de pendientes
  const queue = await api("/api/product?all=true&status=PENDING_REVIEW", { token: admin.token });
  const queueJson = await queue.json();
  assert.ok(queueJson.data.some((p) => p._id === id));

  // editor NO puede aprobar su propio producto
  const editorApprove = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "APPROVED" },
  });
  assert.equal(editorApprove.status, 403);

  // shop_manager tampoco puede aprobar
  const shopApprove = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: shopManager.token,
    body: { toStatus: "APPROVED" },
  });
  assert.equal(shopApprove.status, 403);

  // admin aprueba
  const approve = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: admin.token,
    body: { toStatus: "APPROVED" },
  });
  assert.equal(approve.status, 200);

  // Sigue sin ser publico (APPROVED, no PUBLISHED)
  const approvedPublic = await api(`/api/product/${id}`);
  assert.equal(approvedPublic.status, 404);

  // editor NO puede publicar
  const editorPublish = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "PUBLISHED" },
  });
  assert.equal(editorPublish.status, 403);

  // shop_manager NO puede publicar
  const shopPublish = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: shopManager.token,
    body: { toStatus: "PUBLISHED" },
  });
  assert.equal(shopPublish.status, 403);

  // admin publica
  const publish = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: admin.token,
    body: { toStatus: "PUBLISHED" },
  });
  assert.equal(publish.status, 200);
  const publishJson = await publish.json();
  assert.equal(publishJson.data.status, "PUBLISHED");
  assert.equal(publishJson.data.isActive, true);

  // AHORA si es publico
  const finalPublic = await api(`/api/product/${id}`);
  assert.equal(finalPublic.status, 200);

  const list = await api("/api/product");
  const listJson = await list.json();
  assert.ok(listJson.data.some((p) => p._id === id));
});

test("edicion controlada: editor NO puede editar contenido de un PUBLISHED; PUBLISHED->DRAFT reabre el ciclo", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();
  const id = product._id;

  await api(`/api/product/${id}/status`, { method: "PATCH", token: editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "APPROVED" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "PUBLISHED" } });

  // editor intenta editar contenido directamente -> 403
  const editBlocked = await api(`/api/product/${id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { name: "Nombre cambiado sin permiso" },
  });
  assert.equal(editBlocked.status, 403);

  // admin SI puede editar contenido de un PUBLISHED directamente (autoridad final)
  const adminEdits = await api(`/api/product/${id}`, {
    method: "PATCH",
    token: admin.token,
    body: { name: "Nombre editado por admin" },
  });
  assert.equal(adminEdits.status, 200);

  // "edicion controlada": PUBLISHED -> DRAFT (el editor SI puede iniciar esto sobre su propio producto)
  const toDraft = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "DRAFT" },
  });
  assert.equal(toDraft.status, 200);
  const toDraftJson = await toDraft.json();
  assert.equal(toDraftJson.data.status, "DRAFT");
  assert.equal(toDraftJson.data.isActive, false); // nunca activo en DRAFT

  // ya en DRAFT, el editor SI puede editar contenido
  const editAllowed = await api(`/api/product/${id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { name: "Nombre editado en draft" },
  });
  assert.equal(editAllowed.status, 200);

  // y ya no es publico (volvio a DRAFT)
  const nowHidden = await api(`/api/product/${id}`);
  assert.equal(nowHidden.status, 404);
});

test("rechazo: PENDING_REVIEW -> REJECTED exige motivo; editor corrige y reenvia; admin aprueba y publica", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();
  const id = product._id;

  await api(`/api/product/${id}/status`, { method: "PATCH", token: editorA.token, body: { toStatus: "PENDING_REVIEW" } });

  // rechazo sin motivo -> 400
  const noReason = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: admin.token,
    body: { toStatus: "REJECTED" },
  });
  assert.equal(noReason.status, 400);

  // rechazo con motivo -> 200
  const rejected = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: admin.token,
    body: { toStatus: "REJECTED", rejectionReason: "Falta informacion de tallas." },
  });
  assert.equal(rejected.status, 200);
  const rejectedJson = await rejected.json();
  assert.equal(rejectedJson.data.status, "REJECTED");
  assert.equal(rejectedJson.data.rejectionReason, "Falta informacion de tallas.");

  // editor corrige: REJECTED -> DRAFT
  const backToDraft = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "DRAFT" },
  });
  assert.equal(backToDraft.status, 200);

  // editor reenvia
  const resubmit = await api(`/api/product/${id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "PENDING_REVIEW" },
  });
  assert.equal(resubmit.status, 200);

  // admin aprueba y publica
  const approve = await api(`/api/product/${id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "APPROVED" } });
  assert.equal(approve.status, 200);
  const publish = await api(`/api/product/${id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "PUBLISHED" } });
  assert.equal(publish.status, 200);

  const isPublic = await api(`/api/product/${id}`);
  assert.equal(isPublic.status, 200);
});

// ---------------------------------------------------------------------------
// TRANSICIONES INVALIDAS / OWNERSHIP / PERMISOS
// ---------------------------------------------------------------------------

test("DRAFT -> PUBLISHED directo esta PROHIBIDO para cualquier rol", async (t) => {
  if (guard(t)) return;
  const { editorA, admin, shopManager } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();

  for (const token of [editorA.token, admin.token, shopManager.token]) {
    const res = await api(`/api/product/${product._id}/status`, {
      method: "PATCH",
      token,
      body: { toStatus: "PUBLISHED" },
    });
    assert.equal(res.status, 403);
  }
});

test("ownership: un editor NO puede enviar a revision el producto de OTRO editor", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();

  const res = await api(`/api/product/${product._id}/status`, {
    method: "PATCH",
    token: editorB.token,
    body: { toStatus: "PENDING_REVIEW" },
  });
  assert.equal(res.status, 403);
});

test("ownership: un editor NO puede editar el contenido del producto de OTRO editor", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();

  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorB.token,
    body: { name: "Intento ajeno" },
  });
  assert.equal(res.status, 403);

  // tampoco puede VER el detalle completo (cae a la regla publica -> 404, DRAFT)
  const view = await api(`/api/product/${product._id}`, { token: editorB.token });
  assert.equal(view.status, 404);
});

test("subscriber no accede al workflow administrativo (crear/editar/transicionar)", async (t) => {
  if (guard(t)) return;
  const { subscriber, editorA } = ctx.users;

  const createRes = await api("/api/product", {
    method: "POST",
    token: subscriber.token,
    body: validDraftPayload(),
  });
  assert.equal(createRes.status, 403);

  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraftPayload(),
  });
  const { data: product } = await created.json();

  const patchRes = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: subscriber.token,
    body: { name: "hackeado" },
  });
  assert.equal(patchRes.status, 403);

  const statusRes = await api(`/api/product/${product._id}/status`, {
    method: "PATCH",
    token: subscriber.token,
    body: { toStatus: "PENDING_REVIEW" },
  });
  assert.equal(statusRes.status, 403);

  // el listado admin (?all=true) para subscriber cae al contrato publico (200, sin exponer el draft)
  const listRes = await api("/api/product?all=true", { token: subscriber.token });
  assert.equal(listRes.status, 200);
  const listJson = await listRes.json();
  assert.ok(!listJson.data.some((p) => p._id === product._id));
});

test("shop_manager: conserva CRUD de contenido en DRAFT, pero nunca aprueba/publica ni ve contenido de PUBLISHED sin reabrir", async (t) => {
  if (guard(t)) return;
  const { shopManager, admin } = ctx.users;

  const created = await api("/api/product", {
    method: "POST",
    token: shopManager.token,
    body: validDraftPayload({ name: "Producto de shop_manager" }),
  });
  assert.equal(created.status, 200);
  const { data: product } = await created.json();

  // shop_manager SI puede editar contenido en DRAFT
  const editDraft = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: shopManager.token,
    body: { price: 60000 },
  });
  assert.equal(editDraft.status, 200);

  // shop_manager SI puede enviar a revision y admin publica
  await api(`/api/product/${product._id}/status`, { method: "PATCH", token: shopManager.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${product._id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "APPROVED" } });
  await api(`/api/product/${product._id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "PUBLISHED" } });

  // shop_manager NO puede editar contenido (price) de un PUBLISHED: en ese
  // estado su UNICO campo editable es `isActive`, asi que `price` queda fuera
  // de la lista blanca real y la respuesta es 400 ("no se enviaron campos
  // validos"), no 403 (403 es reservado para "cero campos editables en este
  // producto", que no es el caso: `isActive` si lo es, ver siguiente aserto).
  const editPublished = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: shopManager.token,
    body: { price: 70000 },
  });
  assert.equal(editPublished.status, 400);

  // pero SI puede alternar isActive de un PUBLISHED (palanca operativa, no editorial)
  const toggle = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: shopManager.token,
    body: { isActive: false },
  });
  assert.equal(toggle.status, 200);
  const toggleJson = await toggle.json();
  assert.equal(toggleJson.data.isActive, false);
  assert.equal(toggleJson.data.status, "PUBLISHED"); // no toco el status

  // producto ya no es publico (isActive:false), aunque siga PUBLISHED
  const hidden = await api(`/api/product/${product._id}`);
  assert.equal(hidden.status, 404);
});

// ---------------------------------------------------------------------------
// VISIBILIDAD PUBLICA: nada que no sea PUBLISHED+isActive se filtra
// ---------------------------------------------------------------------------

test("visibilidad publica: DRAFT/PENDING_REVIEW/REJECTED nunca aparecen en GET /product publico", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const { ProductModel } = ctx.models;

  const draft = await api("/api/product", { method: "POST", token: editorA.token, body: validDraftPayload({ name: "WF Draft Publico" }) });
  const { data: draftProduct } = await draft.json();

  const pending = await api("/api/product", { method: "POST", token: editorA.token, body: validDraftPayload({ name: "WF Pending Publico" }) });
  const { data: pendingProduct } = await pending.json();
  await api(`/api/product/${pendingProduct._id}/status`, { method: "PATCH", token: editorA.token, body: { toStatus: "PENDING_REVIEW" } });

  const rejected = await api("/api/product", { method: "POST", token: editorA.token, body: validDraftPayload({ name: "WF Rejected Publico" }) });
  const { data: rejectedProduct } = await rejected.json();
  await api(`/api/product/${rejectedProduct._id}/status`, { method: "PATCH", token: editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${rejectedProduct._id}/status`, {
    method: "PATCH",
    token: admin.token,
    body: { toStatus: "REJECTED", rejectionReason: "motivo" },
  });

  const publicList = await api("/api/product");
  const publicListJson = await publicList.json();
  const ids = publicListJson.data.map((p) => p._id);
  assert.ok(!ids.includes(draftProduct._id));
  assert.ok(!ids.includes(pendingProduct._id));
  assert.ok(!ids.includes(rejectedProduct._id));

  for (const p of [draftProduct, pendingProduct, rejectedProduct]) {
    const detail = await api(`/api/product/${p._id}`);
    assert.equal(detail.status, 404, `producto ${p._id} no deberia ser visible`);
  }

  // Verificacion directa en BD: ninguno de estos 3 documentos es PUBLISHED+isActive
  const raw = await ProductModel.find({
    _id: { $in: [draftProduct._id, pendingProduct._id, rejectedProduct._id] },
  }).lean();
  for (const doc of raw) {
    assert.ok(!(doc.status === "PUBLISHED" && doc.isActive === true));
  }
});
