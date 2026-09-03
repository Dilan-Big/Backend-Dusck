// FASE 3 — Remediación 2 (cierre de hallazgos de Audit 2).
//
//   PD2-001  las transiciones limpian la metadata de workflow del ciclo anterior.
//   PD2-002  isActive:true sólo es alcanzable en PUBLISHED (nunca por PATCH de contenido).
//   PD2-003  el carrito del cliente no expone `status` ni metadata editorial.
//   PD2-004  `variants` malformado -> 400 (nunca 500).
//   PD2-005  quitar todas las variantes sin declarar `stock` -> 400 (no se infiere stock).
//   PD2-009  un producto incompleto no puede AVANZAR hacia publicación.
//
// Base de datos APARTE: `db-dusck-pd2-test`, se elimina al empezar y al terminar.
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Ejecutar:  node --test tests/pd2-remediation.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-pd2-test";
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null;
let mongoAvailable = true;

// Universo de metadata de workflow (debe coincidir con WORKFLOW_METADATA_FIELDS).
const WF_META = [
  "submittedBy",
  "submittedAt",
  "approvedBy",
  "approvedAt",
  "rejectedBy",
  "rejectedAt",
  "rejectionReason",
  "publishedBy",
  "publishedAt",
];

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

    const admin = await makeUser({ name: "Admin PD2", nickname: "admin-pd2", email: "admin-pd2@dusck.com", role: "administrador" });
    const admin2 = await makeUser({ name: "Admin PD2 b", nickname: "admin-pd2-b", email: "admin-pd2-b@dusck.com", role: "administrador" });
    const editorA = await makeUser({ name: "Editor PD2", nickname: "editor-pd2", email: "editor-pd2@dusck.com", role: "editor" });
    const shopManager = await makeUser({ name: "Shop PD2", nickname: "shop-pd2", email: "shop-pd2@dusck.com", role: "shop_manager" });
    const subscriber = await makeUser({ name: "Sub PD2", nickname: "sub-pd2", email: "sub-pd2@dusck.com", role: "subscriber" });

    const cat = await CategoryModel.create({ name: "Cat PD2", slug: "cat-pd2" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, admin2, editorA, shopManager, subscriber },
      cat,
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[pd2-remediation] MongoDB no disponible, se omite la suite: ${err.name}`);
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
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// Payload de DRAFT completo (pasa collectSubmitReviewErrors).
const validDraft = (over = {}) => ({
  name: "Producto PD2",
  slug: `producto-pd2-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion suficiente para revision.",
  price: 42000,
  stock: 6,
  categories: [ctx.cat._id.toString()],
  images: [{ url: "http://dusck.test/pd2.png", isMain: true }],
  ...over,
});

// Crea un producto directamente en BD con overrides (para no recorrer el flujo).
const seedProduct = (over = {}) =>
  ctx.models.ProductModel.create({
    name: "Prod PD2 seed",
    slug: `prod-pd2-seed-${Math.random().toString(36).slice(2, 9)}`,
    description: "descripcion",
    price: 10000,
    stock: 7,
    categories: [ctx.cat._id],
    images: [{ url: "http://dusck.test/seed.png", isMain: true }],
    createdBy: ctx.users.editorA.doc._id,
    ...over,
  });

// Lleva un producto nuevo hasta PUBLISHED por el flujo real.
const createAndPublish = async () => {
  const created = await api("/api/product", { method: "POST", token: ctx.users.editorA.token, body: validDraft() });
  const { data: product } = await created.json();
  const id = product._id;
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "APPROVED" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "PUBLISHED" } });
  return id;
};

const rawDoc = (id) => ctx.models.ProductModel.findById(id).lean();

// ───────────────────────────── PD2-001 ─────────────────────────────────────

test("PD2-001 · Caso 1 — PUBLISHED -> DRAFT elimina publishedBy/At y approvedBy/At", async (t) => {
  if (guard(t)) return;
  const id = await createAndPublish();

  const before = await rawDoc(id);
  assert.ok(before.publishedBy && before.publishedAt && before.approvedBy && before.approvedAt, "precondición: metadata de publicación presente");

  const res = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "DRAFT" } });
  assert.equal(res.status, 200);

  const after = await rawDoc(id);
  assert.equal(after.status, "DRAFT");
  assert.equal(after.isActive, false);
  for (const f of WF_META) {
    assert.ok(after[f] === undefined || after[f] === null, `DRAFT no debe conservar ${f}`);
  }
  // identidad permanente intacta
  assert.ok(after.createdBy);
});

test("PD2-001 · Caso 2 — REJECTED -> DRAFT elimina rejectedBy/At/rejectionReason", async (t) => {
  if (guard(t)) return;
  const created = await api("/api/product", { method: "POST", token: ctx.users.editorA.token, body: validDraft() });
  const { data: product } = await created.json();
  const id = product._id;
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "REJECTED", rejectionReason: "Faltan fotos de detalle." } });

  const rejected = await rawDoc(id);
  assert.ok(rejected.rejectedBy && rejected.rejectedAt && rejected.rejectionReason, "precondición: metadata de rechazo presente");

  const res = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "DRAFT" } });
  assert.equal(res.status, 200);

  const after = await rawDoc(id);
  assert.equal(after.status, "DRAFT");
  for (const f of WF_META) {
    assert.ok(after[f] === undefined || after[f] === null, `DRAFT no debe conservar ${f}`);
  }
});

test("PD2-001 · Caso 3 — REJECTED->DRAFT->PENDING_REVIEW->APPROVED->PUBLISHED sin rastro del rechazo", async (t) => {
  if (guard(t)) return;
  const created = await api("/api/product", { method: "POST", token: ctx.users.editorA.token, body: validDraft() });
  const { data: product } = await created.json();
  const id = product._id;

  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "REJECTED", rejectionReason: "Motivo del ciclo 1." } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "DRAFT" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "APPROVED" } });
  const publish = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "PUBLISHED" } });
  assert.equal(publish.status, 200);

  const after = await rawDoc(id);
  assert.equal(after.status, "PUBLISHED");
  assert.equal(after.isActive, true);
  // metadata coherente con PUBLISHED
  assert.ok(after.submittedBy && after.approvedBy && after.publishedBy);
  // NADA del rechazo del ciclo anterior
  assert.ok(!after.rejectedBy, "no debe conservar rejectedBy");
  assert.ok(!after.rejectedAt, "no debe conservar rejectedAt");
  assert.ok(!after.rejectionReason, "no debe conservar rejectionReason");
});

test("PD2-001 · Caso 4 — un rechazo posterior a una publicación refleja SOLO el ciclo actual", async (t) => {
  if (guard(t)) return;
  const id = await createAndPublish(); // deja approvedBy/publishedBy del ciclo 1

  // ciclo 2: reabrir, reenviar, rechazar
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "DRAFT" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  const rej = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "REJECTED", rejectionReason: "Motivo del ciclo 2." } });
  assert.equal(rej.status, 200);

  const after = await rawDoc(id);
  assert.equal(after.status, "REJECTED");
  assert.equal(after.rejectionReason, "Motivo del ciclo 2.");
  assert.ok(after.rejectedBy && after.rejectedAt);
  assert.ok(after.submittedBy && after.submittedAt);
  // sin rastro de la aprobación/publicación del ciclo 1
  assert.ok(!after.approvedBy, "no debe conservar approvedBy del ciclo previo");
  assert.ok(!after.approvedAt);
  assert.ok(!after.publishedBy, "no debe conservar publishedBy del ciclo previo");
  assert.ok(!after.publishedAt);
});

// ───────────────────────────── PD2-002 ─────────────────────────────────────

for (const status of ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED"]) {
  test(`PD2-002 · PATCH {isActive:true} sobre ${status} -> 400 y sigue inactivo`, async (t) => {
    if (guard(t)) return;
    const extra = status === "REJECTED" ? { rejectionReason: "x", rejectedBy: ctx.users.admin.doc._id, rejectedAt: new Date() } : {};
    const p = await seedProduct({ status, isActive: false, createdBy: ctx.users.editorA.doc._id, ...extra });

    const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.admin.token, body: { isActive: true } });
    assert.equal(res.status, 400, `${status} + isActive:true debe rechazarse`);

    const after = await rawDoc(p._id);
    assert.equal(after.isActive, false);
    assert.equal(after.status, status);
  });
}

test("PD2-002 · PATCH {isActive:false} sobre un DRAFT sigue permitido (idempotente)", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "DRAFT", isActive: false });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.admin.token, body: { isActive: false } });
  assert.equal(res.status, 200);
});

test("PD2-002 · APPROVED -> PUBLISHED sigue activando el producto", async (t) => {
  if (guard(t)) return;
  const id = await createAndPublish();
  const after = await rawDoc(id);
  assert.equal(after.status, "PUBLISHED");
  assert.equal(after.isActive, true);
});

test("PD2-002 · PUBLISHED -> DRAFT deja isActive:false; DRAFT -> PENDING_REVIEW sigue inactivo", async (t) => {
  if (guard(t)) return;
  const id = await createAndPublish();

  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "DRAFT" } });
  assert.equal((await rawDoc(id)).isActive, false);

  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  assert.equal((await rawDoc(id)).isActive, false);
});

// ───────────────────────────── PD2-004 ─────────────────────────────────────

for (const bad of ["invalid", 123, {}, null]) {
  test(`PD2-004 · POST /product con variants=${JSON.stringify(bad)} -> 400 (no 500)`, async (t) => {
    if (guard(t)) return;
    const res = await api("/api/product", {
      method: "POST",
      token: ctx.users.editorA.token,
      body: validDraft({ variants: bad }),
    });
    assert.equal(res.status, 400, `variants ${JSON.stringify(bad)} debe dar 400`);
  });

  test(`PD2-004 · PATCH /product/:id con variants=${JSON.stringify(bad)} -> 400 (no 500)`, async (t) => {
    if (guard(t)) return;
    const p = await seedProduct({ status: "DRAFT", isActive: false });
    const res = await api(`/api/product/${p._id}`, {
      method: "PATCH",
      token: ctx.users.editorA.token,
      body: { variants: bad },
    });
    assert.equal(res.status, 400, `variants ${JSON.stringify(bad)} debe dar 400`);
  });
}

// ───────────────────────────── PD2-005 ─────────────────────────────────────

test("PD2-005 · Caso A — variants:[] sin stock sobre producto variantizado -> 400", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [
      { sku: `PD2-A-${Date.now()}`, color: "Negro", stock: 5 },
      { sku: `PD2-B-${Date.now()}`, color: "Azul", stock: 10 },
    ],
  });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { variants: [] } });
  assert.equal(res.status, 400);

  const after = await rawDoc(p._id);
  assert.equal(after.variants.length, 2, "no se aplicó ningún cambio");
  assert.equal(after.stock, 15);
});

test("PD2-005 · Caso B — variants:[] + stock:20 -> 200, variants vacías, stock 20", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [{ sku: `PD2-C-${Date.now()}`, color: "Negro", stock: 9 }],
  });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { variants: [], stock: 20 } });
  assert.equal(res.status, 200);
  const after = await rawDoc(p._id);
  assert.equal(after.variants.length, 0);
  assert.equal(after.stock, 20);
});

test("PD2-005 · Caso C — producto simple: PATCH {stock:20} sigue funcionando", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "DRAFT", isActive: false, stock: 10 });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { stock: 20 } });
  assert.equal(res.status, 200);
  assert.equal((await rawDoc(p._id)).stock, 20);
});

test("PD2-005 · Caso C-bis — producto ya simple: PATCH {variants:[]} sin stock NO exige nada (no hay conversión)", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "DRAFT", isActive: false, stock: 12 });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { variants: [] } });
  assert.equal(res.status, 200);
  assert.equal((await rawDoc(p._id)).stock, 12);
});

test("PD2-005 · Caso D — PD-003 intacto: PATCH {stock:999} sobre producto variantizado se recalcula", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [
      { sku: `PD2-D1-${Date.now()}`, color: "Negro", stock: 4 },
      { sku: `PD2-D2-${Date.now()}`, color: "Azul", stock: 6 },
    ],
  });
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { stock: 999 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.stock, 10);
});

// ───────────────────────────── PD2-009 ─────────────────────────────────────

test("PD2-009 · DRAFT incompleto: submit-review 400 con lista de errores; PATCH de edición sigue permitido", async (t) => {
  if (guard(t)) return;
  const created = await api("/api/product", {
    method: "POST",
    token: ctx.users.editorA.token,
    body: { name: "Incompleto PD2", slug: `incompleto-pd2-${Date.now()}` }, // sin precio/imagenes/categorias/descripcion
  });
  assert.equal(created.status, 200);
  const { data: product } = await created.json();

  // editar un DRAFT incompleto SÍ se puede
  const edit = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { description: "voy completando" } });
  assert.equal(edit.status, 200);

  // pero NO avanzar a revisión
  const submit = await api(`/api/product/${product._id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  assert.equal(submit.status, 400);
  const json = await submit.json();
  assert.ok(Array.isArray(json.errors) && json.errors.length > 0);
});

test("PD2-009 · DRAFT completo: submit-review 200", async (t) => {
  if (guard(t)) return;
  const created = await api("/api/product", { method: "POST", token: ctx.users.editorA.token, body: validDraft() });
  const { data: product } = await created.json();
  const submit = await api(`/api/product/${product._id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  assert.equal(submit.status, 200);
});

test("PD2-009 · un producto roto por el admin en APPROVED NO puede publicarse (gate en PUBLISHED)", async (t) => {
  if (guard(t)) return;
  const created = await api("/api/product", { method: "POST", token: ctx.users.editorA.token, body: validDraft() });
  const { data: product } = await created.json();
  const id = product._id;

  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.editorA.token, body: { toStatus: "PENDING_REVIEW" } });
  await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "APPROVED" } });

  // admin rompe el contenido (autoridad final: puede editar en cualquier estado)
  const brk = await api(`/api/product/${id}`, { method: "PATCH", token: ctx.users.admin.token, body: { price: 0 } });
  assert.equal(brk.status, 200);

  // ...pero publicar queda bloqueado
  const publish = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "PUBLISHED" } });
  assert.equal(publish.status, 400);
  const json = await publish.json();
  assert.ok(Array.isArray(json.errors) && json.errors.some((e) => e.toLowerCase().includes("precio")));

  // el admin corrige y ahora sí publica
  await api(`/api/product/${id}`, { method: "PATCH", token: ctx.users.admin.token, body: { price: 30000 } });
  const publishOk = await api(`/api/product/${id}/status`, { method: "PATCH", token: ctx.users.admin.token, body: { toStatus: "PUBLISHED" } });
  assert.equal(publishOk.status, 200);
});

// ───────────────────────────── PD2-003 ─────────────────────────────────────

test("PD2-003 · GET /api/cart (cliente) no expone `status` ni metadata editorial", async (t) => {
  if (guard(t)) return;
  const { subscriber, admin } = ctx.users;

  const p = await seedProduct({
    status: "PUBLISHED",
    isActive: true,
    stock: 5,
    approvedBy: admin.doc._id,
    approvedAt: new Date(),
    publishedBy: admin.doc._id,
    publishedAt: new Date(),
  });
  const pid = String(p._id);

  // el cliente lo agrega mientras es comprable
  const add = await api("/api/cart", { method: "PATCH", token: subscriber.token, body: { productId: pid, quantity: 2 } });
  assert.equal(add.status, 200);

  // el producto se despublica
  await api(`/api/product/${pid}`, { method: "PATCH", token: admin.token, body: { isActive: false } });

  // GET /api/cart del cliente
  const cartRes = await api("/api/cart", { token: subscriber.token });
  assert.equal(cartRes.status, 200);
  const body = await cartRes.json();
  const item = body.cart.items.find((i) => (i.productId._id || i.productId).toString() === pid);
  assert.ok(item, "el item sigue en el carrito");

  const prod = item.productId;
  assert.equal("status" in prod, false, "el carrito del cliente NO debe exponer status");
  for (const f of ["approvedBy", "approvedAt", "publishedBy", "publishedAt", "rejectionReason", "createdBy", "submittedBy"]) {
    assert.equal(f in prod, false, `el carrito del cliente NO debe exponer ${f}`);
  }
  // sí lo mínimo para pintar el item
  for (const f of ["name", "price", "images", "stock", "isActive"]) {
    assert.equal(f in prod, true, `el carrito del cliente necesita ${f}`);
  }

  // el cliente puede disminuir / no puede incrementar
  const inc = await api("/api/cart", { method: "PATCH", token: subscriber.token, body: { productId: pid, quantity: 1 } });
  assert.equal(inc.status, 404);
  const dec = await api("/api/cart", { method: "PATCH", token: subscriber.token, body: { productId: pid, quantity: -1 } });
  assert.equal(dec.status, 200);
});

test("PD2-003 · la vista ADMIN del carrito SÍ conserva `status`", async (t) => {
  if (guard(t)) return;
  const { subscriber, admin } = ctx.users;
  const p = await seedProduct({ status: "PUBLISHED", isActive: true, stock: 5 });
  const pid = String(p._id);

  await api("/api/cart", { method: "PATCH", token: subscriber.token, body: { productId: pid, quantity: 1 } });

  const adminList = await api("/api/cart/admin", { token: admin.token });
  assert.equal(adminList.status, 200);
  const body = await adminList.json();
  const anyItem = body.data.flatMap((c) => c.items).find((i) => (i.productId?._id || i.productId)?.toString() === pid);
  assert.ok(anyItem && "status" in anyItem.productId, "la vista admin conserva status");
});
