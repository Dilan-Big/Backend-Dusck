// FASE 5 — Variantes + Stock.
//
// Cubre EXCLUSIVAMENTE lo NUEVO de FASE 5:
//   · stock de variante entero (nuevo validador de schema);
//   · duplicado COLOR+TALLA dentro del mismo producto (nuevo, no existía);
//   · normalización de color/talla para detectar duplicados;
//   · permisos/ownership/estado APLICADOS ESPECÍFICAMENTE sobre `variants`
//     (reutilizan `editableFieldsFor`, ya testeado genéricamente — aquí se
//     confirma que el mismo mecanismo cubre variantes sin huecos);
//   · productos legacy con variantes incompletas;
//   · concurrencia (qué garantiza Mongo/Mongoose y qué NO);
//   · confirmación viva de que `decrementProductStock` (checkout) sigue
//     excluyendo productos con variantes — limitación arquitectónica
//     PRE-EXISTENTE (F4.3-B-R2.2), no introducida ni resuelta por F5.
//
// Lo YA cubierto en otras suites (SKU duplicado local/global, Product.stock =
// suma de variantes al crear/actualizar/eliminar, PD2-005 conversión
// con/sin variantes) NO se reproduce aquí en detalle — se referencia y se
// confirma con la regresión completa (`npm test`), no se duplica.
//   · SKU duplicado: tests/product-workflow.test.js
//   · Stock agregado: tests/pd-remediation.test.js, tests/product-fase1.test.js
//   · variants:[] <-> stock plano: tests/pd2-remediation.test.js (PD2-005)
//
// BD APARTE: `db-dusck-fase5-variants-test`. Sin Mongo -> suite `skip`.
//
// Ejecutar:  node --test tests/product-fase5-variants.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-fase5-variants-test";
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-fase5-variants";

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
    const { decrementProductStock } = await import("../src/services/order.service.js");

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

    const admin = await makeUser({ name: "Admin F5", nickname: "admin-f5", email: "admin-f5@dusck.com", role: "administrador" });
    const shopManager = await makeUser({ name: "Shop F5", nickname: "shop-f5", email: "shop-f5@dusck.com", role: "shop_manager" });
    const editorA = await makeUser({ name: "Editor A F5", nickname: "editor-a-f5", email: "editor-a-f5@dusck.com", role: "editor" });
    const editorB = await makeUser({ name: "Editor B F5", nickname: "editor-b-f5", email: "editor-b-f5@dusck.com", role: "editor" });
    const subscriber = await makeUser({ name: "Sub F5", nickname: "sub-f5", email: "sub-f5@dusck.com", role: "subscriber" });

    const category = await CategoryModel.create({ name: "Hombre F5", slug: "hombre-f5" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, shopManager, editorA, editorB, subscriber },
      category,
      decrementProductStock,
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[product-fase5-variants] MongoDB no disponible, se omite la suite: ${err.name} ${err.message}`);
  }
});

test.after(async () => {
  if (ctx) {
    await ctx.mongoose.connection.dropDatabase();
    await ctx.mongoose.disconnect();
    await new Promise((r) => ctx.server.close(r));
  }
});

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

const api = (path, { method = "GET", body, token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const validDraft = (over = {}) => ({
  name: "Producto F5",
  slug: `producto-f5-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion suficiente.",
  price: 50000,
  stock: 5,
  categories: [ctx.category._id.toString()],
  images: [{ url: "http://dusck.test/f5.png", isMain: true }],
  ...over,
});

const create = async (token, body) => {
  const res = await api("/api/product", { method: "POST", token, body });
  const json = await res.json();
  return { res, product: json.data, json };
};

const patch = (id, token, body) => api(`/api/product/${id}`, { method: "PATCH", token, body });
const setStatus = (id, token, body) => api(`/api/product/${id}/status`, { method: "PATCH", token, body });

const sku = (label) => `SKU-F5-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// ===========================================================================
// VALIDACIÓN
// ===========================================================================

test("F5 validation: variante válida (sku+color+talla+stock) se acepta y persiste", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { res, product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("A"), color: "Blanco", size: "M", stock: 7 }] }),
  );
  assert.equal(res.status, 200);
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0].color, "Blanco");
  assert.equal(product.variants[0].size, "M");
  assert.equal(product.variants[0].stock, 7);
  assert.equal(product.stock, 7, "Product.stock = suma de variants.stock");
});

test("F5 validation: variante sin SKU se rechaza al enviar a revisión", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: "", color: "Negro", size: "M", stock: 3 }],
    }),
  );
  const res = await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.errors.some((e) => /SKU/.test(e)));
});

test("F5 validation: variante sin color se rechaza al enviar a revisión", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("NOCOLOR"), color: "", size: "M", stock: 3 }],
    }),
  );
  const res = await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.errors.some((e) => /color/.test(e)));
});

// F5-CLOSURE — decisión de negocio DEFINITIVA: talla obligatoria en toda
// variante nueva/actualizada. Reemplaza el test anterior de F5 ("variante SIN
// talla se acepta"), que documentaba la laxitud original; los accesorios sin
// tallaje ahora usan el valor convencional "Única" (ver test siguiente), NUNCA
// una talla vacía. Ver F5-CLOSURE report §Decisión aplicada.
test("F5-CLOSURE validation: variante con size vacío (\"\") se rechaza en creación", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("EMPTYSIZE"), color: "Negro", size: "", stock: 10 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /talla/i);
});

test("F5-CLOSURE validation: variante con size solo espacios (\"   \") se rechaza", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("BLANKSIZE"), color: "Negro", size: "   ", stock: 10 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /talla/i);
});

test("F5-CLOSURE validation: variante con size null se rechaza", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("NULLSIZE"), color: "Negro", size: null, stock: 10 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /talla/i);
});

test("F5-CLOSURE validation: variante SIN el campo size (omitido) se rechaza", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("NOSIZE"), color: "Negro", stock: 10 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /talla/i);
});

test('F5-CLOSURE validation: variante con size "Única" se acepta (producto sin tallaje — accesorios)', async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { res, product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("ACC"), color: "Negro", size: "Única", stock: 10 }] }),
  );
  assert.equal(res.status, 200);
  assert.equal(product.variants[0].size, "Única");
});

test('F5-CLOSURE validation: variante con size "M" se acepta (tallas normales siguen funcionando)', async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { res, product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("TM"), color: "Blanco", size: "M", stock: 4 }] }),
  );
  assert.equal(res.status, 200);
  assert.equal(product.variants[0].size, "M");
});

test("F5-CLOSURE validation: variante con size vacío se rechaza también en actualización (PATCH)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("UPDOK"), color: "Negro", size: "M", stock: 5 }] }),
  );
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("UPDBAD"), color: "Negro", size: "", stock: 5 }],
  });
  assert.equal(res.status, 400);
  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.variants[0].size, "M", "la variante original no debe haberse tocado");
});

test("F5 validation: stock decimal en variante se rechaza", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("DEC"), color: "Rojo", size: "L", stock: 2.5 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /entero/i);
});

test("F5 validation: stock negativo en variante se rechaza (creación)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({ variants: [{ sku: sku("NEG"), color: "Verde", size: "S", stock: -1 }] }),
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /negativo/i);
});

test("F5 validation: stock negativo en variante se rechaza (edición vía PATCH)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("EDN"), color: "Azul", size: "M", stock: 5 }] }),
  );
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("EDN2"), color: "Azul", size: "M", stock: -3 }],
  });
  assert.equal(res.status, 400);
  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.variants[0].stock, 5, "el stock original no debe haberse tocado");
});

test("F5 validation: SKU duplicado dentro del mismo producto se rechaza (referencia — cobertura extensa en product-workflow.test.js)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const dupSku = sku("DUP");
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: dupSku, color: "Negro", size: "S", stock: 1 },
        { sku: dupSku, color: "Blanco", size: "M", stock: 2 },
      ],
    }),
  });
  assert.equal(res.status, 409);
});

test("F5 validation: COLOR+TALLA duplicados se rechazan aunque el SKU sea distinto", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: sku("C1"), color: "Blanco", size: "M", stock: 3 },
        { sku: sku("C2"), color: "Blanco", size: "M", stock: 5 }, // mismo color+talla, SKU distinto
      ],
    }),
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.match(json.msg, /color y talla/i);
});

test("F5 validation: dos variantes mismo color, TALLA DISTINTA -> válido (no es duplicado)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: sku("S1"), color: "Negro", size: "S", stock: 1 },
        { sku: sku("S2"), color: "Negro", size: "M", stock: 2 },
      ],
    }),
  });
  assert.equal(res.status, 200);
});

// F5-CLOSURE — antes usaba `size: ""` en ambas variantes (talla ausente como
// "valor comparable"); ahora "" es en sí mismo inválido para una escritura
// nueva (ver tests F5-CLOSURE arriba), así que se usa "Única" — el valor
// convencional para "sin tallaje" — para aislar LO QUE este test realmente
// cubre: el duplicado color+talla sigue detectándose (closure §8), sin que la
// nueva regla de talla obligatoria interfiera con la aserción.
test('F5 validation: dos variantes MISMO color + size "Única" -> duplicado (combo repetido)', async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: sku("N1"), color: "Gris", size: "Única", stock: 1 },
        { sku: sku("N2"), color: "Gris", size: "Única", stock: 2 },
      ],
    }),
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.match(json.msg, /color y talla/i);
});

test("F5 validation: SKU se normaliza por espacios para la detección local de duplicados", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const base = sku("TRIM");
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: `  ${base}  `, color: "Negro", size: "S", stock: 1 },
        { sku: base, color: "Blanco", size: "M", stock: 2 },
      ],
    }),
  });
  assert.equal(res.status, 409);
});

test("F5 validation: color/talla se normalizan (mayúsculas/espacios) para detectar duplicados", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const res = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: validDraft({
      variants: [
        { sku: sku("NORM1"), color: "Blanco", size: "M", stock: 1 },
        { sku: sku("NORM2"), color: "  BLANCO  ", size: "m", stock: 2 }, // mismo combo normalizado
      ],
    }),
  });
  assert.equal(res.status, 409);
});

// ===========================================================================
// STOCK AGREGADO (crear / editar / eliminar variante actualiza Product.stock)
// ===========================================================================

test("F5 aggregate: añadir una variante vía PATCH actualiza Product.stock", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("AGG1"), color: "Negro", size: "S", stock: 4 }] }),
  );
  assert.equal(product.stock, 4);

  const res = await patch(product._id, editorA.token, {
    variants: [
      { sku: sku("AGG1B"), color: "Negro", size: "S", stock: 4 },
      { sku: sku("AGG2"), color: "Negro", size: "M", stock: 6 },
    ],
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.stock, 10);
});

test("F5 aggregate: editar el stock de una variante actualiza Product.stock", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("EDIT"), color: "Rojo", size: "L", stock: 4 }] }),
  );
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("EDIT2"), color: "Rojo", size: "L", stock: 20 }],
  });
  const json = await res.json();
  assert.equal(json.data.stock, 20);
});

test("F5 aggregate: eliminar una variante actualiza Product.stock", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      variants: [
        { sku: sku("DEL1"), color: "Negro", size: "S", stock: 4 },
        { sku: sku("DEL2"), color: "Negro", size: "M", stock: 6 },
      ],
    }),
  );
  assert.equal(product.stock, 10);
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("DEL1B"), color: "Negro", size: "S", stock: 4 }],
  });
  const json = await res.json();
  assert.equal(json.data.stock, 4);
});

// ===========================================================================
// STOCKOPS / CHECKOUT / CART — confirmación de compatibilidad
// ===========================================================================

test("F5 checkout: decrementProductStock SIGUE excluyendo productos con variantes (limitación arquitectónica pre-existente, no tocada por F5)", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("CO"), color: "Negro", size: "M", stock: 10 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  const result = await ctx.decrementProductStock(product._id, 1, `test-op:${product._id}`);
  assert.equal(
    result.outcome,
    "stock_conflict",
    "un producto con variantes NUNCA debe poder decrementarse via checkout hoy — ver F5 report",
  );

  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.stock, 10, "el stock agregado no debe haberse tocado");
});

// TALLAS — el comportamiento esperado CAMBIÓ: CartItem ahora lleva un `size`
// OPCIONAL (texto libre, el mismo de `variants[].size`). Sigue SIN `variantId`
// y sin ninguna estructura de variantes nueva — solo la talla, que es lo mínimo
// para transportar la selección. Un item sin `size` == producto simple (compat).
test("F5 cart: CartItem lleva { productId, quantity, size } — size opcional, sin variantId", async (t) => {
  if (guard(t)) return;
  const CartModel = (await import("../src/models/cart.model.js")).default;
  const paths = CartModel.schema.path("items").schema.paths;
  assert.deepEqual(
    Object.keys(paths).sort(),
    ["productId", "quantity", "size"].sort(),
    "CartItem = productId/quantity/size (nada de variantId/color/sku)",
  );
  assert.equal(paths.size.isRequired, undefined, "`size` NO es obligatorio (producto simple no la lleva)");
});

// ===========================================================================
// SEGURIDAD Y PERMISOS (rol + ownership + estado, sobre `variants`)
// ===========================================================================

test("F5 security: editor AJENO no puede modificar variantes de un producto que no le pertenece (403)", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ variants: [] }));
  const res = await patch(product._id, editorB.token, {
    variants: [{ sku: sku("AJENO"), color: "Negro", size: "M", stock: 1 }],
  });
  assert.equal(res.status, 403);
});

test("F5 security: editor con producto en PENDING_REVIEW NO puede editar variantes", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("PR"), color: "Negro", size: "M", stock: 1 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });

  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("PR2"), color: "Negro", size: "M", stock: 99 }],
  });
  assert.equal(res.status, 403);
});

test("F5 security: editor con producto en DRAFT SI puede editar variantes", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ variants: [] }));
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("DRAFT"), color: "Negro", size: "M", stock: 3 }],
  });
  assert.equal(res.status, 200);
});

test("F5 security: editor con producto en REJECTED SI puede editar variantes", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("REJ"), color: "Negro", size: "M", stock: 1 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "REJECTED", comment: "No procede" });

  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("REJ2"), color: "Negro", size: "M", stock: 8 }],
  });
  assert.equal(res.status, 200);
});

test("F5 security: editor con producto en CHANGES_REQUESTED SI puede editar variantes", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("CR"), color: "Negro", size: "M", stock: 1 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "Ajusta las tallas" });

  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("CR2"), color: "Negro", size: "M", stock: 8 }],
  });
  assert.equal(res.status, 200);
});

test("F5 security: administrador mantiene permisos existentes — edita variantes incluso en PUBLISHED", async (t) => {
  if (guard(t)) return;
  const { editorA, admin } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("ADM"), color: "Negro", size: "M", stock: 1 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  const res = await patch(product._id, admin.token, {
    variants: [{ sku: sku("ADM2"), color: "Negro", size: "M", stock: 50 }],
  });
  assert.equal(res.status, 200);
});

test("F5 security: shop_manager mantiene permisos existentes — NO puede editar variantes de un PUBLISHED", async (t) => {
  if (guard(t)) return;
  const { editorA, admin, shopManager } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({
      details: "d",
      shippingInfo: "s",
      returnsInfo: "r",
      variants: [{ sku: sku("SM"), color: "Negro", size: "M", stock: 1 }],
    }),
  );
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  const res = await patch(product._id, shopManager.token, {
    variants: [{ sku: sku("SM2"), color: "Negro", size: "M", stock: 99 }],
  });
  // shop_manager SÍ puede tocar `isActive` en PUBLISHED (palanca operativa),
  // pero NO `variants` — `editableFieldsFor` le devuelve `["isActive"]`
  // (longitud > 0, así que NO cae en la rama 403 "sin campos editables"), y
  // como el body solo trae `variants` (nada en la whitelist real),
  // `pickAllowed` lo deja vacío -> 400 "No se enviaron campos válidos para
  // actualizar". Es el MISMO contrato pre-existente para cualquier campo de
  // contenido (name, images, etc.), no una regla nueva de F5.
  assert.equal(res.status, 400);
  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.variants[0].stock, 1, "el stock no debe haber cambiado");
});

test("F5 security: subscriber no puede tocar variantes (sin acceso al CRUD administrativo)", async (t) => {
  if (guard(t)) return;
  const { editorA, subscriber } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ variants: [] }));
  const res = await patch(product._id, subscriber.token, {
    variants: [{ sku: sku("SUB"), color: "Negro", size: "M", stock: 1 }],
  });
  assert.equal(res.status, 403);
});

test("F5 security: campos protegidos no pueden colarse junto a `variants` en el mismo PATCH", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ variants: [] }));
  const res = await patch(product._id, editorA.token, {
    variants: [{ sku: sku("PROT"), color: "Negro", size: "M", stock: 3 }],
    status: "PUBLISHED", // intento de colarse — ignorado por whitelist
    createdBy: editorB.doc._id.toString(), // intento de robar ownership — ignorado
  });
  assert.equal(res.status, 200);
  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.status, "DRAFT", "status no debe cambiar via PATCH de contenido");
  assert.equal(String(fresh.createdBy), String(editorA.doc._id), "createdBy no debe poder robarse");
});

// ===========================================================================
// PRODUCTOS LEGACY
// ===========================================================================

test("F5 legacy: producto con variante incompleta insertada directamente (sin talla, sin SKU) sigue siendo legible y editable", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  // Inserción CRUDA (bypass de Mongoose/validators), simulando un documento
  // legado anterior a cualquier regla de F5.
  const raw = await ctx.models.ProductModel.collection.insertOne({
    name: "Legacy F5",
    slug: `legacy-f5-${Date.now()}`,
    description: "x",
    price: 1000,
    images: [{ url: "http://d/legacy.png", isMain: true }],
    variants: [{ sku: "", color: "Negro", size: "", stock: 5 }],
    stock: 5,
    categories: [],
    status: "DRAFT",
    isActive: false,
    createdBy: editorA.doc._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const getRes = await api(`/api/product/${raw.insertedId}`, { token: editorA.token });
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.data.variants[0].sku, "");

  // Editable sin exigir migración: un PATCH que NO toca `variants` sigue
  // funcionando sobre el documento legado tal cual.
  const patchRes = await patch(raw.insertedId.toString(), editorA.token, { name: "Legacy F5 renombrado" });
  assert.equal(patchRes.status, 200);
});

// F5-CLOSURE — la regla de talla obligatoria SÍ se aplica a una escritura
// NUEVA sobre un producto legacy: no migra la variante vieja (eso sigue
// prohibido), pero tampoco permite persistir OTRA variante sin talla.
test("F5-CLOSURE legacy: introducir una variante NUEVA sin size en un producto legacy se rechaza", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const raw = await ctx.models.ProductModel.collection.insertOne({
    name: "Legacy F5 CLOSURE",
    slug: `legacy-f5-closure-${Date.now()}`,
    description: "x",
    price: 1000,
    images: [{ url: "http://d/legacy2.png", isMain: true }],
    variants: [{ sku: "", color: "Negro", size: "", stock: 5 }],
    stock: 5,
    categories: [],
    status: "DRAFT",
    isActive: false,
    createdBy: editorA.doc._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const res = await patch(raw.insertedId.toString(), editorA.token, {
    variants: [{ sku: sku("LEGNEW"), color: "Blanco", size: "", stock: 3 }],
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /talla/i);

  const fresh = await ctx.models.ProductModel.findById(raw.insertedId).lean();
  assert.equal(fresh.variants.length, 1, "el intento rechazado no debe haber tocado el array persistido");
});

// F5-CLOSURE — un PATCH que NO toca `variants` sigue funcionando sobre el
// documento legado (arriba); pero AVANZAR el workflow (envío a revisión) sí
// exige que cada variante persistida cumpla el contrato completo, igual que
// ya exigía SKU/color — ver `collectSubmitReviewErrors`.
test("F5-CLOSURE legacy: producto legacy con variante sin talla NO puede enviarse a revisión sin corregirla", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const raw = await ctx.models.ProductModel.collection.insertOne({
    name: "Legacy F5 Submit",
    slug: `legacy-f5-submit-${Date.now()}`,
    description: "Descripcion suficiente.",
    price: 1000,
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
    images: [{ url: "http://d/legacy3.png", isMain: true }],
    variants: [{ sku: `LEG-SUB-${Date.now()}`, color: "Negro", size: "", stock: 5 }],
    stock: 5,
    categories: [ctx.category._id],
    status: "DRAFT",
    isActive: false,
    createdBy: editorA.doc._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const res = await setStatus(raw.insertedId.toString(), editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.errors.some((e) => /talla/i.test(e)));
});

test("F5 legacy: producto SIN variants[] (array vacío, comportamiento clásico) sigue usando el stock plano", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft({ variants: [], stock: 25 }));
  assert.equal(product.stock, 25);
  const res = await patch(product._id, editorA.token, { stock: 30 });
  const json = await res.json();
  assert.equal(json.data.stock, 30, "producto simple: stock plano sigue siendo la fuente de verdad");
});

// ===========================================================================
// CONCURRENCIA
// ===========================================================================

test("F5 concurrency: dos intentos concurrentes de crear el MISMO SKU en productos distintos -> uno gana, el otro 409 (protegido por el índice único, no por el pre-check)", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;
  const sharedSku = sku("RACE");

  const [r1, r2] = await Promise.all([
    api("/api/product", {
      method: "POST",
      token: editorA.token,
      body: validDraft({ variants: [{ sku: sharedSku, color: "Negro", size: "M", stock: 1 }] }),
    }),
    api("/api/product", {
      method: "POST",
      token: editorB.token,
      body: validDraft({ variants: [{ sku: sharedSku, color: "Blanco", size: "L", stock: 1 }] }),
    }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactamente una request debe ganar el SKU, la otra debe chocar con el índice");
});

test("F5 concurrency: la misma combinación color+talla puede existir en DOS productos distintos simultáneamente (el chequeo es LOCAL, no global)", async (t) => {
  if (guard(t)) return;
  const { editorA, editorB } = ctx.users;

  const [r1, r2] = await Promise.all([
    api("/api/product", {
      method: "POST",
      token: editorA.token,
      body: validDraft({ variants: [{ sku: sku("LOCAL1"), color: "Blanco", size: "M", stock: 1 }] }),
    }),
    api("/api/product", {
      method: "POST",
      token: editorB.token,
      body: validDraft({ variants: [{ sku: sku("LOCAL2"), color: "Blanco", size: "M", stock: 1 }] }),
    }),
  ]);

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
});

test("F5 concurrency: dos PATCH simultáneos sobre el MISMO producto -> last-write-wins determinista (comportamiento YA existente para todo campo de contenido, no exclusivo de variantes — Mongo no fusiona, cada findOneAndUpdate reemplaza el array completo)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("RACEV"), color: "Negro", size: "M", stock: 5 }] }),
  );

  const [r1, r2] = await Promise.all([
    patch(product._id, editorA.token, {
      variants: [{ sku: sku("RACEV-A"), color: "Negro", size: "M", stock: 10 }],
    }),
    patch(product._id, editorA.token, {
      variants: [{ sku: sku("RACEV-B"), color: "Negro", size: "M", stock: 20 }],
    }),
  ]);

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);

  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  // El resultado final es EXACTAMENTE lo que escribió UNA de las dos
  // requests (10 o 20) — nunca una fusión (p. ej. 30) ni un estado corrupto.
  // MongoDB garantiza que cada `findOneAndUpdate` es atómico POR SÍ SOLO
  // (todo el documento se reemplaza de una vez); NO garantiza que dos
  // escrituras concurrentes se combinen — la segunda en aplicarse
  // simplemente sobrescribe el array completo de la primera. Es el mismo
  // comportamiento que ya rige `name`/`categories`/`images` — no es una
  // regresión de F5 ni algo que F5 deba resolver (ver F5 report §concurrencia).
  assert.ok(
    fresh.variants[0].stock === 10 || fresh.variants[0].stock === 20,
    `stock final inesperado: ${fresh.variants[0].stock}`,
  );
  assert.equal(fresh.stock, fresh.variants[0].stock, "Product.stock sigue sincronizado con la variante que ganó la carrera");
});

// ===========================================================================
// REGRESIÓN puntual
// ===========================================================================

test("F5 regresion: PATCH que no toca `variants` sigue funcionando igual que antes", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const { product } = await create(
    editorA.token,
    validDraft({ variants: [{ sku: sku("REG"), color: "Negro", size: "M", stock: 5 }] }),
  );
  const res = await patch(product._id, editorA.token, { description: "Nueva descripción" });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.data.description, "Nueva descripción");
  assert.equal(json.data.stock, 5, "el stock derivado no debe alterarse por un PATCH que no toca variants");
});
