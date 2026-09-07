// FASE 2 — Backend/API contract hardening.
//
// F2 NO añade lógica de dominio nueva: F1 + F1-CLOSURE ya construyeron el
// contrato. Esta suite lo AUDITA y lo BLINDA a nivel HTTP:
//   · CRUD: POST fuerza DRAFT / isActive:false / createdBy; campos privilegiados
//     del body ignorados en POST y en PATCH.
//   · PATCH: whitelist `editableFieldsFor`; status/isActive/*By/*At/
//     workflowHistory/createdBy/stockOps NO modificables por contenido.
//   · Workflow: `PATCH /:id/status` es el ÚNICO cambio de status; matriz de
//     autorización por rol/ownership.
//   · Listados: separación pública vs editorial; ownership del editor.
//   · Contrato de errores: 400 / 401 / 403 / 404 / 409 en su disparador canónico.
//   · Concurrencia: 1×200 / 1×409, historial coherente.
//   · Cart / checkout / stockOps / variants: NO tocados (verificación negativa).
//
// BD APARTE: `db-dusck-fase2-test`. Skip si no hay MongoDB.
// Ejecutar:  node --test tests/product-fase2.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-fase2-test";
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

    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]);

    const makeUser = async (over) => {
      const doc = await UserModel.create({ password: encryptedPassword("Secret123"), status: true, ...over });
      const token = generateToken({
        _id: doc._id, name: doc.name, email: doc.email, nickname: doc.nickname, role: doc.role,
      });
      return { doc, token };
    };

    const admin = await makeUser({ name: "Admin F2", nickname: "admin-f2", email: "admin-f2@dusck.com", role: "administrador" });
    const admin2 = await makeUser({ name: "Admin2 F2", nickname: "admin2-f2", email: "admin2-f2@dusck.com", role: "administrador" });
    const editorA = await makeUser({ name: "Editor A F2", nickname: "editor-a-f2", email: "editor-a-f2@dusck.com", role: "editor" });
    const editorB = await makeUser({ name: "Editor B F2", nickname: "editor-b-f2", email: "editor-b-f2@dusck.com", role: "editor" });
    const shopManager = await makeUser({ name: "Shop F2", nickname: "shop-f2", email: "shop-f2@dusck.com", role: "shop_manager" });
    const subscriber = await makeUser({ name: "Sub F2", nickname: "sub-f2", email: "sub-f2@dusck.com", role: "subscriber" });

    const catHombre = await CategoryModel.create({ name: "Hombre F2", slug: "hombre-f2" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, admin2, editorA, editorB, shopManager, subscriber },
      categories: { hombre: catHombre },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[product-fase2] MongoDB no disponible, se omite la suite: ${err.name}`);
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

const validDraft = (over = {}) => ({
  name: "Producto F2",
  slug: `producto-f2-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion suficiente para revision.",
  price: 79000,
  stock: 8,
  details: "Composicion 100% algodon.",
  shippingInfo: "Envio nacional 2-4 dias.",
  returnsInfo: "Cambios dentro de 30 dias.",
  categories: [ctx.categories.hombre._id.toString()],
  images: [{ url: "http://dusck.test/f2.png", isMain: true }],
  ...over,
});

const create = async (token, body) => {
  const res = await api("/api/product", { method: "POST", token, body });
  const json = await res.json().catch(() => ({}));
  return { res, product: json.data, json };
};
const setStatus = (id, token, body) => api(`/api/product/${id}/status`, { method: "PATCH", token, body });
const raw = (id) => ctx.models.ProductModel.findById(id).lean();

const advanceTo = async (id, target) => {
  const { admin, editorA } = ctx.users;
  if (target === "DRAFT") return;
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" });
  if (target === "PENDING_REVIEW") return;
  if (target === "CHANGES_REQUESTED") return void (await setStatus(id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "c" }));
  if (target === "REJECTED") return void (await setStatus(id, admin.token, { toStatus: "REJECTED", comment: "no" }));
  await setStatus(id, admin.token, { toStatus: "APPROVED" });
  if (target === "APPROVED") return;
  await setStatus(id, admin.token, { toStatus: "PUBLISHED" });
  if (target === "PUBLISHED") return;
  if (target === "ARCHIVED") return void (await setStatus(id, admin.token, { toStatus: "ARCHIVED" }));
  throw new Error(`advanceTo: ${target}`);
};

// ===========================================================================
// F2.2 — POST /api/product: nace DRAFT, campos privilegiados ignorados
// ===========================================================================

test("crud · POST fuerza status=DRAFT aunque el body pida PUBLISHED/APPROVED", async (t) => {
  if (guard(t)) return;
  for (const forced of ["PUBLISHED", "APPROVED", "REJECTED", "ARCHIVED", "CHANGES_REQUESTED"]) {
    const { res, product } = await create(ctx.users.editorA.token, validDraft({ status: forced }));
    assert.equal(res.status, 200);
    assert.equal(product.status, "DRAFT", `body status:${forced} -> DRAFT`);
    assert.equal(product.isActive, false);
  }
});

test("crud · POST fuerza isActive=false aunque el body pida true", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft({ isActive: true }));
  assert.equal(product.isActive, false);
});

test("crud · POST ignora metadata editorial del body (*By / *At / workflowHistory)", async (t) => {
  if (guard(t)) return;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      publishedAt: new Date().toISOString(),
      publishedBy: fakeId,
      approvedAt: new Date().toISOString(),
      approvedBy: fakeId,
      submittedAt: new Date().toISOString(),
      submittedBy: fakeId,
      rejectedBy: fakeId,
      rejectedAt: new Date().toISOString(),
      rejectionReason: "inyectado",
      updatedBy: fakeId,
      workflowHistory: [{ action: "publish", fromStatus: "APPROVED", toStatus: "PUBLISHED", by: fakeId }],
    }),
  );
  const doc = await raw(product._id);
  assert.ok(!doc.publishedAt && !doc.publishedBy, "sin metadata de publicación");
  assert.ok(!doc.approvedAt && !doc.approvedBy, "sin metadata de aprobación");
  assert.ok(!doc.submittedAt && !doc.submittedBy, "sin metadata de envío");
  assert.ok(!doc.rejectedBy && !doc.rejectedAt && !doc.rejectionReason, "sin metadata de rechazo");
  assert.deepEqual(doc.workflowHistory, [], "workflowHistory no inyectable");
});

test("crud · POST fuerza createdBy = usuario autenticado (ignora el del body)", async (t) => {
  if (guard(t)) return;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();
  const { product } = await create(ctx.users.editorA.token, validDraft({ createdBy: fakeId }));
  const doc = await raw(product._id);
  assert.equal(String(doc.createdBy), String(ctx.users.editorA.doc._id));
});

test("crud · POST solo con campos privilegiados (sin name/slug) -> 400 de schema", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", {
    method: "POST",
    token: ctx.users.editorA.token,
    body: { status: "PUBLISHED", isActive: true },
  });
  assert.equal(res.status, 400);
});

// ===========================================================================
// F2.3 — PATCH /api/product/:id: whitelist, campos protegidos
// ===========================================================================

test("patch · un PATCH de contenido NUNCA cambia status (status no está en la whitelist)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { status: "PENDING_REVIEW" },
  });
  assert.equal(res.status, 400, "solo status -> ningún campo válido -> 400");
  assert.equal((await raw(product._id)).status, "DRAFT");
});

test("patch · campos protegidos en el body se descartan; solo el contenido válido se aplica", async (t) => {
  if (guard(t)) return;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const before = await raw(product._id);

  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: {
      details: "detalle nuevo legítimo",
      status: "APPROVED",
      isActive: true,
      publishedAt: new Date().toISOString(),
      publishedBy: fakeId,
      approvedBy: fakeId,
      submittedBy: fakeId,
      createdBy: fakeId,
      workflowHistory: [{ action: "approve", fromStatus: "PENDING_REVIEW", toStatus: "APPROVED", by: fakeId }],
      stockOps: [{ id: "x:y", qty: 1, state: "decremented" }],
      stockOpsPruned: true,
    },
  });
  assert.equal(res.status, 200);
  const after = await raw(product._id);
  assert.equal(after.details, "detalle nuevo legítimo", "el contenido legítimo SÍ se aplica");
  assert.equal(after.status, "DRAFT", "status intacto");
  assert.equal(after.isActive, false, "isActive intacto");
  assert.ok(!after.publishedAt && !after.publishedBy, "metadata de publicación intacta");
  assert.ok(!after.approvedBy && !after.submittedBy, "metadata de workflow intacta");
  assert.equal(String(after.createdBy), String(before.createdBy), "createdBy intacto");
  assert.deepEqual(after.workflowHistory, [], "workflowHistory intacto");
  assert.deepEqual(after.stockOps, [], "stockOps intacto");
});

test("patch · editor NO puede tocar isActive ni siquiera en un estado editable", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { isActive: true },
  });
  assert.equal(res.status, 400, "isActive no está en editableFieldsFor(editor)");
  assert.equal((await raw(product._id)).isActive, false);
});

test("patch · admin: isActive:true sobre un DRAFT -> 400 (invariante PD2-002)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.admin.token,
    body: { isActive: true },
  });
  assert.equal(res.status, 400);
});

test("patch · stockOps en el body -> descartado (solo stockOps -> 400 sin campos válidos)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { stockOps: [{ id: "a:b", qty: 5, state: "decremented" }] },
  });
  assert.equal(res.status, 400);
  assert.deepEqual((await raw(product._id)).stockOps, []);
});

test("patch · Product.stock con variantes: se ignora el stock plano del body (derivado)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ variants: [{ sku: `F2-V-${Date.now()}`, color: "N", size: "Única", stock: 3 }] }),
  );
  assert.equal(product.stock, 3);
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { stock: 999 },
  });
  // stock plano sin tocar variantes: el service lo re-deriva de las variantes persistidas
  assert.equal(res.status, 200);
  assert.equal((await raw(product._id)).stock, 3, "stock sigue siendo Σ variants.stock");
});

// ===========================================================================
// F2.4 / F2.5 — matriz de autorización del workflow
// ===========================================================================

// El EDITOR nunca puede ejecutar acciones administrativas, desde ningún estado.
const EDITOR_FORBIDDEN = [
  ["PENDING_REVIEW", "APPROVED"],
  ["PENDING_REVIEW", "REJECTED"],
  ["PENDING_REVIEW", "CHANGES_REQUESTED"],
  ["APPROVED", "PUBLISHED"],
  ["PUBLISHED", "ARCHIVED"],
  ["REJECTED", "ARCHIVED"],
  ["ARCHIVED", "DRAFT"],
];

for (const [from, to] of EDITOR_FORBIDDEN) {
  test(`authz · editor NO puede ${from} -> ${to} (403)`, async (t) => {
    if (guard(t)) return;
    const { product } = await create(ctx.users.editorA.token, validDraft());
    await advanceTo(product._id, from);
    const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: to, comment: "x" });
    assert.equal(res.status, 403);
  });
}

test("authz · shop_manager NO puede approve / reject / publish / archive / request_changes", async (t) => {
  if (guard(t)) return;
  const { shopManager } = ctx.users;
  const p1 = (await create(ctx.users.editorA.token, validDraft())).product;
  await advanceTo(p1._id, "PENDING_REVIEW");
  assert.equal((await setStatus(p1._id, shopManager.token, { toStatus: "APPROVED" })).status, 403);
  assert.equal((await setStatus(p1._id, shopManager.token, { toStatus: "REJECTED", comment: "x" })).status, 403);
  assert.equal((await setStatus(p1._id, shopManager.token, { toStatus: "CHANGES_REQUESTED", comment: "x" })).status, 403);

  const p2 = (await create(ctx.users.editorA.token, validDraft())).product;
  await advanceTo(p2._id, "APPROVED");
  assert.equal((await setStatus(p2._id, shopManager.token, { toStatus: "PUBLISHED" })).status, 403);

  const p3 = (await create(ctx.users.editorA.token, validDraft())).product;
  await advanceTo(p3._id, "PUBLISHED");
  assert.equal((await setStatus(p3._id, shopManager.token, { toStatus: "ARCHIVED" })).status, 403);
});

test("authz · admin ejecuta la máquina de estados completa (todas las transiciones válidas)", async (t) => {
  if (guard(t)) return;
  const { admin, editorA } = ctx.users;
  const p = (await create(editorA.token, validDraft())).product;
  const ok = async (token, toStatus, comment) => {
    const r = await setStatus(p._id, token, comment ? { toStatus, comment } : { toStatus });
    assert.equal(r.status, 200, `${toStatus}`);
  };
  await ok(editorA.token, "PENDING_REVIEW");
  await ok(admin.token, "CHANGES_REQUESTED", "ajusta");
  await ok(editorA.token, "PENDING_REVIEW");
  await ok(admin.token, "REJECTED", "no va");
  await ok(editorA.token, "DRAFT");
  await ok(editorA.token, "PENDING_REVIEW");
  await ok(admin.token, "APPROVED");
  await ok(admin.token, "PUBLISHED");
  await ok(admin.token, "ARCHIVED");
  await ok(admin.token, "DRAFT");
});

test("authz · subscriber: sin acceso al dominio Product (POST / PATCH / status)", async (t) => {
  if (guard(t)) return;
  const { subscriber, editorA } = ctx.users;
  assert.equal((await create(subscriber.token, validDraft())).res.status, 403);
  const { product } = await create(editorA.token, validDraft());
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: subscriber.token, body: { name: "x" } })).status,
    403,
  );
  assert.equal((await setStatus(product._id, subscriber.token, { toStatus: "PENDING_REVIEW" })).status, 403);
});

test("authz · DELETE /api/product/:id: editor NO puede; admin sí", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const editorDel = await api(`/api/product/${product._id}`, { method: "DELETE", token: ctx.users.editorA.token });
  assert.equal(editorDel.status, 403, "editor no borra");
  const adminDel = await api(`/api/product/${product._id}`, { method: "DELETE", token: ctx.users.admin.token });
  assert.equal(adminDel.status, 200, "admin sí borra");
});

test("authz · ownership: editor solo transiciona su propio producto", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await setStatus(product._id, ctx.users.editorB.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 403);
});

// ===========================================================================
// F2.10 / F2.12 — separación pública vs editorial
// ===========================================================================

// F7-A — el contrato público se AMPLIÓ (`PUBLIC_PRODUCT_FIELDS` en
// product.services.js): `details`/`shippingInfo`/`returnsInfo`/`modelInfo`/
// `publishedAt` pasan de EDITORIAL_ONLY a PUBLIC; `variants` se expone pero
// SOLO `{color,size,stock}` — `sku` sigue siendo editorial-only. El resto de
// la lista editorial (status/workflowHistory/createdBy/stockOps/etc.) no
// cambia.
const EDITORIAL_ONLY_FIELDS = [
  "status", "workflowHistory", "createdBy", "updatedBy",
  "submittedBy", "submittedAt", "approvedBy", "approvedAt",
  "rejectedBy", "rejectedAt", "rejectionReason",
  "publishedBy", "stockOps",
];
const PUBLIC_FIELDS = [
  "name", "slug", "description", "price", "images", "categories", "stock", "isActive",
  "details", "shippingInfo", "returnsInfo", "modelInfo", "publishedAt", "variants",
];

test("visibility · GET público (anónimo) de un PUBLISHED: campos públicos ampliados (F7-A), cero metadata editorial", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      modelInfo: { size: "M", heightCm: 180 },
      variants: [{ sku: "F7-SKU-SECRETO", color: "Negro", size: "M", stock: 5 }],
    }),
  );
  await advanceTo(product._id, "PUBLISHED");

  const detail = await api(`/api/product/${product._id}`);
  assert.equal(detail.status, 200);
  const d = (await detail.json()).data;
  for (const f of EDITORIAL_ONLY_FIELDS) {
    assert.equal(f in d, false, `el API público NO debe exponer "${f}"`);
  }
  for (const f of PUBLIC_FIELDS) assert.equal(f in d, true, `el API público SÍ expone "${f}"`);

  // publishedAt es una fecha real (no vacía, no la de creación/edición).
  assert.ok(d.publishedAt, "publishedAt tiene valor");
  assert.ok(!Number.isNaN(Date.parse(d.publishedAt)), "publishedAt es una fecha parseable");

  // F7-A — variants[]: color/size/stock sí, sku NUNCA (dato interno de inventario).
  assert.equal(d.variants.length, 1);
  assert.equal(d.variants[0].color, "Negro");
  assert.equal(d.variants[0].size, "M");
  assert.equal(d.variants[0].stock, 5);
  assert.equal("sku" in d.variants[0], false, "el API público NO debe exponer variants[].sku");

  // F7-A — categories poblado con {_id, name, slug}, no el ObjectId crudo.
  assert.equal(d.categories.length, 1);
  assert.equal(typeof d.categories[0], "object");
  assert.equal(d.categories[0].name, ctx.categories.hombre.name);
  assert.equal(d.categories[0].slug, ctx.categories.hombre.slug);
  assert.equal("isActive" in d.categories[0], false, "no se expone metadata de categoría más allá de name/slug");

  const list = await api("/api/product");
  const item = (await list.json()).data.find((p) => p._id === product._id);
  assert.ok(item);
  for (const f of EDITORIAL_ONLY_FIELDS) assert.equal(f in item, false, `lista pública NO expone "${f}"`);
  assert.equal("sku" in (item.variants?.[0] ?? {}), false, "lista pública tampoco expone variants[].sku");
});

test("visibility · GET editorial (dueño) de un CHANGES_REQUESTED: expone workflowHistory + metadata", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  await setStatus(product._id, ctx.users.admin.token, {
    toStatus: "CHANGES_REQUESTED",
    comment: "Falta la imagen posterior del producto.",
  });

  const res = await api(`/api/product/${product._id}`, { token: ctx.users.editorA.token });
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.status, "CHANGES_REQUESTED");
  assert.ok(Array.isArray(d.workflowHistory) && d.workflowHistory.length >= 2);
  const last = d.workflowHistory.at(-1);
  assert.equal(last.action, "request_changes");
  assert.equal(last.comment, "Falta la imagen posterior del producto.");
  assert.ok(last.by, "el actor del comentario se conserva");
  assert.ok(last.at, "el timestamp se conserva");
  assert.ok(d.createdBy, "el editorial expone createdBy");
  assert.ok(d.submittedAt, "el editorial expone submittedAt");
});

test("visibility · un editor NO ve el detalle editorial de un producto ajeno (cae a regla pública -> 404)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, { token: ctx.users.editorB.token });
  assert.equal(res.status, 404);
});

test("visibility · admin ve el detalle editorial de CUALQUIER producto y estado", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, { token: ctx.users.admin.token });
  assert.equal(res.status, 200);
  const d = (await res.json()).data;
  assert.equal(d.status, "DRAFT");
  assert.ok("workflowHistory" in d);
});

// ===========================================================================
// F2.11 — editor list (ownership) + F2.12 admin review data
// ===========================================================================

test("list · editor ?all=true ve SOLO sus productos, en todos los estados", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB, admin } = ctx.users;
  const mineDraft = (await create(editorA.token, validDraft({ name: "A draft" }))).product;
  const minePub = (await create(editorA.token, validDraft({ name: "A pub" }))).product;
  await advanceTo(minePub._id, "PUBLISHED");
  const theirs = (await create(editorB.token, validDraft({ name: "B draft" }))).product;

  const res = await api("/api/product?all=true", { token: editorA.token });
  assert.equal(res.status, 200);
  const ids = (await res.json()).data.map((p) => p._id);
  assert.ok(ids.includes(mineDraft._id));
  assert.ok(ids.includes(minePub._id), "incluye los propios ya publicados");
  assert.ok(!ids.includes(theirs._id), "NO incluye los de otro editor");
});

test("list · ?status= filtra dentro del alcance permitido (editor: sus PENDING_REVIEW)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const d = (await create(editorA.token, validDraft())).product;
  const pr = (await create(editorA.token, validDraft())).product;
  await advanceTo(pr._id, "PENDING_REVIEW");

  const res = await api("/api/product?all=true&status=PENDING_REVIEW", { token: editorA.token });
  const ids = (await res.json()).data.map((p) => p._id);
  assert.ok(ids.includes(pr._id));
  assert.ok(!ids.includes(d._id));
});

test("list · ?status= inválido se ignora (no rompe, devuelve el alcance completo)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product?all=true&status=NO_EXISTE", { token: ctx.users.admin.token });
  assert.equal(res.status, 200);
});

// F7-B — Ningún query param del storefront puede saltarse PUBLIC_FILTER. El
// filtro `req.query.status` del controller SOLO se aplica DENTRO de la rama
// `wantsAll && isAdminCapable(role)`; sin esas dos condiciones, `getProduct`
// devuelve siempre `dbGetPublicProducts()` (PUBLISHED+isActive hardcodeado),
// ignorando cualquier `?status=`/`?all=` que mande el cliente.
test("F7-B · ?status=DRAFT sin sesión NO filtra por status arbitrario: sigue siendo el catálogo público", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const draft = (await create(editorA.token, validDraft())).product; // permanece DRAFT

  for (const attempt of [
    "/api/product?status=DRAFT",
    "/api/product?all=true&status=DRAFT",
    "/api/product?all=false&status=DRAFT",
  ]) {
    const res = await api(attempt);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.ok(!data.some((p) => p._id === draft._id), `"${attempt}" no debe filtrar el DRAFT hacia la respuesta pública`);
    assert.ok(!data.some((p) => p.status === "DRAFT"), `"${attempt}" no debe traer NINGÚN producto DRAFT`);
  }
});

test("F7-B · ?status=APPROVED/ARCHIVED con sesión de subscriber tampoco filtra: sigue siendo el catálogo público", async (t) => {
  if (guard(t)) return;
  const { editorA, admin, subscriber } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  // producto queda APPROVED (nunca PUBLISHED): no debe ser público bajo ningún query param.

  for (const attempt of [
    `/api/product?all=true&status=APPROVED`,
    `/api/product?status=ARCHIVED`,
  ]) {
    const res = await api(attempt, { token: subscriber.token });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.ok(!data.some((p) => p._id === product._id), `"${attempt}" (subscriber) no debe exponer el APPROVED`);
  }
});

test("review-data · admin ?all=true&status=PENDING_REVIEW trae los datos de revisión", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const p = (await create(editorA.token, validDraft())).product;
  await advanceTo(p._id, "PENDING_REVIEW");

  const res = await api("/api/product?all=true&status=PENDING_REVIEW", { token: admin.token });
  const item = (await res.json()).data.find((x) => x._id === p._id);
  assert.ok(item, "el producto está en la cola");
  // F6 — `createdBy` llega POBLADO ({_id, name, nickname}), no como ObjectId
  // crudo (el comentario original de F2 decía "F6 resolverá el nombre").
  assert.ok(item.createdBy, "creador disponible");
  assert.equal(item.createdBy.name, editorA.doc.name, "createdBy trae el nombre resuelto");
  assert.ok(item.createdAt, "createdAt disponible");
  assert.ok(item.submittedAt, "submittedAt disponible");
  assert.ok(Array.isArray(item.workflowHistory) && item.workflowHistory.length >= 1);
  assert.equal(item.workflowHistory.at(-1).by.name, editorA.doc.name, "workflowHistory[].by también trae el nombre resuelto");
});

// F6 — Admin Review: quién puede ENCONTRAR la cola de PENDING_REVIEW.
// (la autoridad para ACTUAR sobre ella — approve/reject/request_changes — ya
// está cubierta en detalle en product-fase1.test.js "authz · shop_manager NO
// gana request_changes ni archive" / "authz · subscriber no accede al
// workflow"; aquí solo se cubre la VISIBILIDAD de la cola en sí).
test("review-queue · shop_manager SÍ puede ver la cola de PENDING_REVIEW (solo lectura, no puede actuar)", async (t) => {
  if (guard(t)) return;
  const { editorA, shopManager } = ctx.users;
  const p = (await create(editorA.token, validDraft())).product;
  await advanceTo(p._id, "PENDING_REVIEW");

  const res = await api("/api/product?all=true&status=PENDING_REVIEW", { token: shopManager.token });
  assert.equal(res.status, 200);
  const ids = (await res.json()).data.map((x) => x._id);
  assert.ok(ids.includes(p._id), "shop_manager ve el producto en la cola");
});

test("review-queue · subscriber NO accede a la cola administrativa (cae al contrato público)", async (t) => {
  if (guard(t)) return;
  const { editorA, subscriber } = ctx.users;
  const p = (await create(editorA.token, validDraft())).product;
  await advanceTo(p._id, "PENDING_REVIEW");

  const res = await api("/api/product?all=true&status=PENDING_REVIEW", { token: subscriber.token });
  assert.equal(res.status, 200);
  const ids = (await res.json()).data.map((x) => x._id);
  assert.ok(!ids.includes(p._id), "subscriber NUNCA ve PENDING_REVIEW (cae al filtro público PUBLISHED+isActive)");
});

test("review-queue · sin sesión (anónimo) tampoco accede a la cola", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const p = (await create(editorA.token, validDraft())).product;
  await advanceTo(p._id, "PENDING_REVIEW");

  const res = await api("/api/product?all=true&status=PENDING_REVIEW");
  assert.equal(res.status, 200);
  const ids = (await res.json()).data.map((x) => x._id);
  assert.ok(!ids.includes(p._id));
});

test("review-detail · GET /product/:id inexistente para admin -> 404", async (t) => {
  if (guard(t)) return;
  const { admin } = ctx.users;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();
  const res = await api(`/api/product/${fakeId}`, { token: admin.token });
  assert.equal(res.status, 404);
});

// ===========================================================================
// F2.13 — contrato de errores (disparador canónico por código)
// ===========================================================================

test("errors · 401 sin x-token en POST /api/product", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", { method: "POST", body: validDraft() });
  assert.equal(res.status, 401);
});

test("errors · 401 con x-token inválido", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", { method: "POST", token: "no-es-un-jwt", body: validDraft() });
  assert.equal(res.status, 401);
});

test("errors · 403 rol no autorizado (subscriber POST)", async (t) => {
  if (guard(t)) return;
  assert.equal((await create(ctx.users.subscriber.token, validDraft())).res.status, 403);
});

test("errors · 400 ObjectId inválido en GET /api/product/:id", async (t) => {
  if (guard(t)) return;
  assert.equal((await api("/api/product/no-es-objectid")).status, 400);
});

test("errors · 400 toStatus ausente / inválido en PATCH /:id/status", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  assert.equal((await setStatus(product._id, ctx.users.editorA.token, {})).status, 400);
  assert.equal((await setStatus(product._id, ctx.users.editorA.token, { toStatus: "NOPE" })).status, 400);
});

test("errors · 400 comentario obligatorio: CHANGES_REQUESTED y REJECTED sin comment", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  assert.equal((await setStatus(product._id, ctx.users.admin.token, { toStatus: "CHANGES_REQUESTED" })).status, 400);
  assert.equal((await setStatus(product._id, ctx.users.admin.token, { toStatus: "REJECTED" })).status, 400);
});

test("errors · 400 submit incompleto -> { msg, errors: [...] }", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft({ details: "" }));
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(typeof body.msg === "string");
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
});

test("errors · 404 producto inexistente", async (t) => {
  if (guard(t)) return;
  const ghost = new ctx.mongoose.Types.ObjectId().toString();
  assert.equal((await api(`/api/product/${ghost}`, { token: ctx.users.admin.token })).status, 404);
  assert.equal(
    (await setStatus(ghost, ctx.users.admin.token, { toStatus: "APPROVED" })).status,
    404,
  );
});

test("errors · 404 (no 403) para anónimo pidiendo el detalle de un DRAFT (no revela existencia)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`);
  assert.equal(res.status, 404);
});

test("errors · 409 slug duplicado", async (t) => {
  if (guard(t)) return;
  const slug = `dup-f2-${Date.now()}`;
  assert.equal((await create(ctx.users.editorA.token, validDraft({ slug }))).res.status, 200);
  assert.equal((await create(ctx.users.editorA.token, validDraft({ slug }))).res.status, 409);
});

test("errors · 409 transición concurrente (misma arista dos veces en paralelo)", async (t) => {
  if (guard(t)) return;
  const { admin, admin2, editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  const [r1, r2] = await Promise.all([
    setStatus(product._id, admin.token, { toStatus: "APPROVED" }),
    setStatus(product._id, admin2.token, { toStatus: "APPROVED" }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
});

test("errors · formato de error siempre { msg } (compat frontend)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product/no-es-objectid");
  const body = await res.json();
  assert.equal(typeof body.msg, "string");
});

// ===========================================================================
// F2.14 — concurrencia: historial coherente
// ===========================================================================

test("concurrency · aprobar vs solicitar cambios en paralelo -> 1x200 / 1x409, history coherente", async (t) => {
  if (guard(t)) return;
  const { admin, admin2, editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const [r1, r2] = await Promise.all([
    setStatus(product._id, admin.token, { toStatus: "APPROVED" }),
    setStatus(product._id, admin2.token, { toStatus: "CHANGES_REQUESTED", comment: "c" }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);

  const doc = await raw(product._id);
  const submitCount = doc.workflowHistory.filter((e) => e.action === "submit").length;
  const winnerCount = doc.workflowHistory.filter((e) => ["approve", "request_changes"].includes(e.action)).length;
  assert.equal(submitCount, 1);
  assert.equal(winnerCount, 1, "solo la transición ganadora quedó en el historial");
  assert.equal(doc.workflowHistory.at(-1).toStatus, doc.status);
});

// ===========================================================================
// F2.15 / F2.17 — Cart / Checkout / stockOps / variants: NO tocados
// ===========================================================================

test("integrity · el carrito sigue leyendo product.stock / status / isActive sin cambios", async (t) => {
  if (guard(t)) return;
  const { editorA, subscriber } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ stock: 5 }));
  await advanceTo(product._id, "PUBLISHED");
  const pubDoc = await raw(product._id);
  assert.equal(pubDoc.status, "PUBLISHED");
  assert.equal(pubDoc.isActive, true, "precondición: el producto quedó publicado y activo");

  // agregar al carrito: contrato intacto { productId, quantity } (delta con signo)
  const add = await api("/api/cart", {
    method: "PATCH",
    token: subscriber.token,
    body: { productId: String(product._id), quantity: 2 },
  });
  assert.equal(add.status, 200);
  const body = await add.json();
  const item = body.data.items.find((i) => String(i.productId._id || i.productId) === String(product._id));
  assert.equal(item.quantity, 2, "quantity sigue siendo el delta acumulado");
  // el populate del carrito NO expone metadata editorial (ni la nueva de F1)
  const prod = item.productId;
  for (const f of ["workflowHistory", "details", "shippingInfo", "returnsInfo", "modelInfo", "status"]) {
    assert.equal(f in prod, false, `el carrito del cliente NO expone "${f}"`);
  }
});

test("integrity · un producto no-PUBLISHED no es comprable (contrato de carrito intacto)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const add = await api("/api/cart", {
    method: "PATCH",
    token: ctx.users.subscriber.token,
    body: { productId: String(product._id), quantity: 1 },
  });
  assert.equal(add.status, 404, "CHANGES_REQUESTED no es comprable");
});

test("integrity · stockOps y stock derivado intactos tras operaciones F2 (variantes)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      variants: [
        { sku: `F2-INT-${Date.now()}-S`, color: "N", size: "S", stock: 4 },
        { sku: `F2-INT-${Date.now()}-M`, color: "N", size: "M", stock: 6 },
      ],
    }),
  );
  assert.equal(product.stock, 10);
  const doc = await raw(product._id);
  assert.deepEqual(doc.stockOps, [], "stockOps nace vacío y F2 no lo toca");
  assert.equal(doc.variants.length, 2, "variantes intactas: color/size/sku/stock");
});

// ===========================================================================
// F2-CLOSURE-1 — PATCH /api/product/:id : contrato de permisos exacto
//
// Contrato REAL verificado en código:
//   · ruta:  authorizationUser(['administrador','shop_manager','editor'])
//            -> el editor SÍ entra a PATCH /:id (a diferencia de DELETE /:id,
//               que es ['administrador','shop_manager'] — de ahí la aparente
//               contradicción del reporte F2: era la fila de DELETE).
//   · controller: editableFieldsFor(product, user) — [] => 403; si no, la
//               whitelist real (contenido) acotada por rol + estado + ownership.
//   · `status` NUNCA está en la whitelist -> un PATCH de contenido no mueve el
//               workflow.
// ===========================================================================

const CONTENT_EDIT = { details: "detalle editado por el flujo editorial" };

test("closure1 · editor propietario + DRAFT -> PUEDE editar contenido (200)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: CONTENT_EDIT });
  assert.equal(res.status, 200);
  assert.equal((await raw(product._id)).details, CONTENT_EDIT.details);
});

test("closure1 · editor propietario + REJECTED -> PUEDE editar contenido (200)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "REJECTED");
  const res = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: CONTENT_EDIT });
  assert.equal(res.status, 200);
  assert.equal((await raw(product._id)).details, CONTENT_EDIT.details);
});

test("closure1 · editor propietario + CHANGES_REQUESTED -> PUEDE editar contenido (200)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const res = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: CONTENT_EDIT });
  assert.equal(res.status, 200);
  assert.equal((await raw(product._id)).details, CONTENT_EDIT.details);
});

for (const state of ["PENDING_REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"]) {
  test(`closure1 · editor propietario + ${state} (estado NO editable) -> 403`, async (t) => {
    if (guard(t)) return;
    const { product } = await create(ctx.users.editorA.token, validDraft());
    await advanceTo(product._id, state);
    const res = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: CONTENT_EDIT });
    assert.equal(res.status, 403);
  });
}

test("closure1 · editor AJENO -> 403 (aunque el estado sea editable)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft()); // DRAFT
  const res = await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorB.token, body: CONTENT_EDIT });
  assert.equal(res.status, 403);
});

test("closure1 · editor NO cambia status vía PATCH de contenido (status fuera de la whitelist)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  // solo status -> 400 (ningún campo válido); combinado -> status descartado
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { status: "PUBLISHED" } })).status,
    400,
  );
  const combo = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { details: "x", status: "APPROVED" },
  });
  assert.equal(combo.status, 200);
  assert.equal((await raw(product._id)).status, "DRAFT", "status intacto");
});

test("closure1 · admin conserva su autoridad: edita contenido en estados NO editables por el editor", async (t) => {
  if (guard(t)) return;
  for (const state of ["PENDING_REVIEW", "APPROVED", "PUBLISHED"]) {
    const { product } = await create(ctx.users.editorA.token, validDraft());
    await advanceTo(product._id, state);
    const res = await api(`/api/product/${product._id}`, {
      method: "PATCH",
      token: ctx.users.admin.token,
      body: { details: `admin edita en ${state}` },
    });
    assert.equal(res.status, 200, `admin edita contenido en ${state}`);
  }
});

test("closure1 · shop_manager conserva sus permisos actuales: contenido en DRAFT (200), en PUBLISHED solo isActive (price -> 400)", async (t) => {
  if (guard(t)) return;
  const { shopManager, admin } = ctx.users;
  const { product } = await create(shopManager.token, validDraft({ name: "SM closure1" }));
  // DRAFT: shop_manager edita contenido
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: shopManager.token, body: { price: 55000 } })).status,
    200,
  );
  // llega a PUBLISHED (shop_manager envía su propio producto; admin aprueba y publica)
  assert.equal((await setStatus(product._id, shopManager.token, { toStatus: "PENDING_REVIEW" })).status, 200);
  assert.equal((await setStatus(product._id, admin.token, { toStatus: "APPROVED" })).status, 200);
  assert.equal((await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" })).status, 200);
  // PUBLISHED: price queda fuera de su whitelist -> 400 (no 403: isActive sí es editable)
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: shopManager.token, body: { price: 66000 } })).status,
    400,
  );
  // pero isActive sí (palanca operativa) — desactivar es coherente en PUBLISHED
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: shopManager.token, body: { isActive: false } })).status,
    200,
  );
});

// ===========================================================================
// F2-CLOSURE-2 — invariante isActive === true  <=>  status === PUBLISHED
// ===========================================================================

test("closure2 · POST -> status DRAFT + isActive false", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft({ status: "PUBLISHED", isActive: true }));
  assert.equal(product.status, "DRAFT");
  assert.equal(product.isActive, false);
});

test("closure2 · editor NO puede modificar isActive (fuera de su whitelist)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  // solo isActive -> 400 (ningún campo válido para el editor)
  assert.equal(
    (await api(`/api/product/${product._id}`, { method: "PATCH", token: ctx.users.editorA.token, body: { isActive: true } })).status,
    400,
  );
  // combinado con contenido -> isActive se descarta silenciosamente
  await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { details: "x", isActive: true },
  });
  assert.equal((await raw(product._id)).isActive, false);
});

for (const [state, actor] of [
  ["DRAFT", "admin"],
  ["PENDING_REVIEW", "admin"],
  ["CHANGES_REQUESTED", "admin"],
  ["REJECTED", "admin"],
  ["APPROVED", "admin"],
  ["ARCHIVED", "admin"],
  ["DRAFT", "shopManager"],
]) {
  test(`closure2 · PATCH { isActive:true } sobre ${state} por ${actor} -> 400 (invariante)`, async (t) => {
    if (guard(t)) return;
    const { product } = await create(ctx.users.editorA.token, validDraft());
    await advanceTo(product._id, state);
    const res = await api(`/api/product/${product._id}`, {
      method: "PATCH",
      token: ctx.users[actor].token,
      body: { isActive: true },
    });
    assert.equal(res.status, 400);
    assert.equal((await raw(product._id)).isActive, false);
  });
}

test("closure2 · PATCH { isActive:false } sobre un estado no-PUBLISHED es inofensivo (200, idempotente)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.admin.token,
    body: { isActive: false },
  });
  assert.equal(res.status, 200);
  assert.equal((await raw(product._id)).isActive, false);
});

test("closure2 · recorrido del workflow: isActive coherente con status en CADA transición", async (t) => {
  if (guard(t)) return;
  const { admin, editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  const id = product._id;
  const check = async (expectedStatus) => {
    const d = await raw(id);
    assert.equal(d.status, expectedStatus);
    assert.equal(d.isActive, expectedStatus === "PUBLISHED", `${expectedStatus} -> isActive:${expectedStatus === "PUBLISHED"}`);
  };

  await check("DRAFT");
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" }); await check("PENDING_REVIEW");
  await setStatus(id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "c" }); await check("CHANGES_REQUESTED");
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" }); await check("PENDING_REVIEW");
  await setStatus(id, admin.token, { toStatus: "REJECTED", comment: "r" }); await check("REJECTED");
  await setStatus(id, editorA.token, { toStatus: "DRAFT" }); await check("DRAFT");
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" }); await check("PENDING_REVIEW");
  await setStatus(id, admin.token, { toStatus: "APPROVED" }); await check("APPROVED");
  await setStatus(id, admin.token, { toStatus: "PUBLISHED" }); await check("PUBLISHED");
  await setStatus(id, admin.token, { toStatus: "DRAFT" }); await check("DRAFT");            // edición controlada
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(id, admin.token, { toStatus: "APPROVED" });
  await setStatus(id, admin.token, { toStatus: "PUBLISHED" }); await check("PUBLISHED");
  await setStatus(id, admin.token, { toStatus: "ARCHIVED" }); await check("ARCHIVED");
  await setStatus(id, admin.token, { toStatus: "DRAFT" }); await check("DRAFT");
});

test("closure2 · admin/shop_manager NO pueden crear un estado inconsistente vía PATCH ni combinando campos", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "APPROVED"); // el paso más "cercano" a publicar
  // intento de "publicar por la puerta de atrás": contenido + isActive:true
  const sneaky = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.admin.token,
    body: { details: "x", isActive: true },
  });
  assert.equal(sneaky.status, 400, "APPROVED + isActive:true -> 400");
  const d = await raw(product._id);
  assert.equal(d.status, "APPROVED");
  assert.equal(d.isActive, false);
});
