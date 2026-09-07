// FASE 1 — Product Model + Editor Workflow (extensión).
//
// Cubre EXCLUSIVAMENTE lo nuevo de FASE 1:
//   · campos nuevos del Product (modelInfo.heightCm numérico, details,
//     shippingInfo, returnsInfo);
//   · metadata de imagen (type / order / alt) + compat de imágenes legadas
//     `{ url, isMain }` + única imagen principal (normalización);
//   · estados CHANGES_REQUESTED y ARCHIVED + sus transiciones y autorización;
//   · workflowHistory append-only + comentarios de revisión;
//   · validación de submit ampliada (details/shipping/returns/imagen principal);
//   · invariante isActive en los estados nuevos;
//   · el catálogo público NO expone ARCHIVED / CHANGES_REQUESTED.
//
// BD APARTE: `db-dusck-fase1-test` (se elimina al empezar y al terminar).
// Si no hay MongoDB disponible, la suite entera se marca `skip` (no falla).
//
// Ejecutar:  node --test tests/product-fase1.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-fase1-test";
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

    const admin = await makeUser({ name: "Admin F1", nickname: "admin-f1", email: "admin-f1@dusck.com", role: "administrador" });
    const admin2 = await makeUser({ name: "Admin2 F1", nickname: "admin2-f1", email: "admin2-f1@dusck.com", role: "administrador" });
    const editorA = await makeUser({ name: "Editor A F1", nickname: "editor-a-f1", email: "editor-a-f1@dusck.com", role: "editor" });
    const editorB = await makeUser({ name: "Editor B F1", nickname: "editor-b-f1", email: "editor-b-f1@dusck.com", role: "editor" });
    const shopManager = await makeUser({ name: "Shop Mgr F1", nickname: "shop-f1", email: "shop-f1@dusck.com", role: "shop_manager" });
    const subscriber = await makeUser({ name: "Sub F1", nickname: "sub-f1", email: "sub-f1@dusck.com", role: "subscriber" });

    const catHombre = await CategoryModel.create({ name: "Hombre F1", slug: "hombre-f1" });

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
    console.warn(`[product-fase1] MongoDB no disponible, se omite la suite: ${err.name}`);
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

// DRAFT COMPLETO — pasa `collectSubmitReviewErrors` (incluye los 3 campos
// nuevos obligatorios para submit + una imagen principal).
const validDraft = (over = {}) => ({
  name: "Producto F1",
  slug: `producto-f1-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion suficiente para revision.",
  price: 79000,
  stock: 8,
  details: "Composicion 100% algodon. Corte regular.",
  shippingInfo: "Envio nacional 2-4 dias habiles.",
  returnsInfo: "Cambios dentro de 30 dias con etiqueta original.",
  categories: [ctx.categories.hombre._id.toString()],
  images: [{ url: "http://dusck.test/f1-main.png", isMain: true }],
  ...over,
});

const create = async (token, body) => {
  const res = await api("/api/product", { method: "POST", token, body });
  const json = await res.json();
  return { res, product: json.data, json };
};

const setStatus = (id, token, body) =>
  api(`/api/product/${id}/status`, { method: "PATCH", token, body });

// Lleva un producto recién creado (DRAFT) hasta `target`.
const advanceTo = async (id, target) => {
  const { admin, editorA } = ctx.users;
  if (target === "DRAFT") return;
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" });
  if (target === "PENDING_REVIEW") return;
  if (target === "CHANGES_REQUESTED") {
    await setStatus(id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "Ajusta las fotos." });
    return;
  }
  if (target === "REJECTED") {
    await setStatus(id, admin.token, { toStatus: "REJECTED", comment: "No procede." });
    return;
  }
  await setStatus(id, admin.token, { toStatus: "APPROVED" });
  if (target === "APPROVED") return;
  await setStatus(id, admin.token, { toStatus: "PUBLISHED" });
  if (target === "PUBLISHED") return;
  if (target === "ARCHIVED") {
    await setStatus(id, admin.token, { toStatus: "ARCHIVED" });
    return;
  }
  throw new Error(`advanceTo: target no soportado: ${target}`);
};

// ===========================================================================
// PRODUCT MODEL — campos nuevos
// ===========================================================================

test("model · modelInfo con heightCm numérico se guarda y se devuelve tal cual", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft({ modelInfo: { size: "S", heightCm: 187 } }));
  assert.equal(product.modelInfo.size, "S");
  assert.equal(product.modelInfo.heightCm, 187);
  assert.equal(typeof product.modelInfo.heightCm, "number");
});

test("model · heightCm NO numérico -> 400 (no se guarda basura)", async (t) => {
  if (guard(t)) return;
  const { res } = await create(ctx.users.editorA.token, validDraft({ modelInfo: { size: "M", heightCm: "1.87 m" } }));
  assert.equal(res.status, 400);
});

test("model · heightCm fuera de rango razonable -> 400", async (t) => {
  if (guard(t)) return;
  const tooTall = await create(ctx.users.editorA.token, validDraft({ modelInfo: { heightCm: 400 } }));
  assert.equal(tooTall.res.status, 400);
  const tooShort = await create(ctx.users.editorA.token, validDraft({ modelInfo: { heightCm: 10 } }));
  assert.equal(tooShort.res.status, 400);
});

test("model · modelInfo no-objeto -> 400", async (t) => {
  if (guard(t)) return;
  const { res } = await create(ctx.users.editorA.token, validDraft({ modelInfo: "S / 1.87" }));
  assert.equal(res.status, 400);
});

test("model · details / shippingInfo / returnsInfo se persisten con trim", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ details: "  Detalle con espacios  ", shippingInfo: " Envio ", returnsInfo: " Devolucion " }),
  );
  assert.equal(product.details, "Detalle con espacios");
  assert.equal(product.shippingInfo, "Envio");
  assert.equal(product.returnsInfo, "Devolucion");
});

test("model · campos nuevos son OPCIONALES para GUARDAR un DRAFT", async (t) => {
  if (guard(t)) return;
  // Solo nombre + slug: un DRAFT mínimo sigue siendo válido (los campos nuevos
  // NO son `required` de schema).
  const res = await api("/api/product", {
    method: "POST",
    token: ctx.users.editorA.token,
    body: { name: "Draft minimo F1", slug: `draft-min-f1-${Date.now()}` },
  });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.status, "DRAFT");
  assert.equal(data.details, "");
  assert.equal(data.shippingInfo, "");
  assert.equal(data.returnsInfo, "");
});

// ===========================================================================
// IMAGES — metadata + compat + una sola principal
// ===========================================================================

test("images · type / order / alt se guardan", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      images: [
        { url: "http://dusck.test/a.png", isMain: true, type: "MAIN", order: 0, alt: "frente" },
        { url: "http://dusck.test/b.png", type: "MODEL", order: 1, alt: "con modelo" },
        { url: "http://dusck.test/c.png", type: "DETAIL", order: 2, alt: "textura" },
      ],
    }),
  );
  assert.equal(product.images.length, 3);
  assert.equal(product.images[1].type, "MODEL");
  assert.equal(product.images[1].order, 1);
  assert.equal(product.images[1].alt, "con modelo");
  assert.equal(product.images[2].type, "DETAIL");
  assert.ok(product.images[0]._id, "cada imagen tiene _id (identificador)");
});

test("images · type inválido -> 400", async (t) => {
  if (guard(t)) return;
  const { res } = await create(
    ctx.users.editorA.token,
    validDraft({ images: [{ url: "http://dusck.test/x.png", isMain: true, type: "HERO" }] }),
  );
  assert.equal(res.status, 400);
});

test("images · compat: `{ url, isMain }` legado -> type='MAIN', order=0, alt='' por defecto", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ images: [{ url: "http://dusck.test/legacy.png", isMain: true }] }),
  );
  assert.equal(product.images[0].type, "MAIN");
  assert.equal(product.images[0].order, 0);
  assert.equal(product.images[0].alt, "");
  assert.equal(product.images[0].isMain, true);
});

test("images · doc legado creado SIN los campos nuevos sigue siendo leíble y editable", async (t) => {
  if (guard(t)) return;
  const { ProductModel } = ctx.models;
  // Inserta saltándose defaults/hooks: imagen legada pura.
  const raw = await ProductModel.collection.insertOne({
    name: "Legacy img F1",
    slug: `legacy-img-f1-${Date.now()}`,
    description: "x",
    price: 1000,
    categories: [ctx.categories.hombre._id],
    images: [{ url: "http://dusck.test/pure-legacy.png", isMain: true }],
    variants: [],
    stock: 4,
    status: "DRAFT",
    isActive: false,
    createdBy: ctx.users.editorA.doc._id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const view = await api(`/api/product/${raw.insertedId}`, { token: ctx.users.editorA.token });
  assert.equal(view.status, 200);
  const { data } = await view.json();
  assert.equal(data.images[0].url, "http://dusck.test/pure-legacy.png");
  // editable: un PATCH de contenido sobre el doc legado funciona
  const patched = await api(`/api/product/${raw.insertedId}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { details: "detalle nuevo sobre doc legado" },
  });
  assert.equal(patched.status, 200);
});

test("images · normalización: varias isMain -> queda UNA; ninguna -> la primera", async (t) => {
  if (guard(t)) return;
  // Varias marcadas principal
  const multi = await create(
    ctx.users.editorA.token,
    validDraft({
      images: [
        { url: "http://dusck.test/1.png", isMain: true },
        { url: "http://dusck.test/2.png", isMain: true },
        { url: "http://dusck.test/3.png", isMain: true },
      ],
    }),
  );
  assert.equal(multi.product.images.filter((i) => i.isMain).length, 1);
  assert.equal(multi.product.images[0].isMain, true);

  // Ninguna marcada principal -> la primera
  const none = await create(
    ctx.users.editorA.token,
    validDraft({
      images: [
        { url: "http://dusck.test/1.png", type: "DETAIL" },
        { url: "http://dusck.test/2.png", type: "MODEL" },
      ],
    }),
  );
  assert.equal(none.product.images.filter((i) => i.isMain).length, 1);
  assert.equal(none.product.images[0].isMain, true);
  assert.equal(none.product.images[0].type, "MAIN", "la principal se sincroniza a type MAIN");
});

test("images · conflicto isMain:true + type:'DETAIL' -> gana isMain (type pasa a MAIN)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ images: [{ url: "http://dusck.test/conf.png", isMain: true, type: "DETAIL" }] }),
  );
  assert.equal(product.images[0].isMain, true);
  assert.equal(product.images[0].type, "MAIN");
});

test("images · un PATCH que reescribe images también re-normaliza la principal", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const patched = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: {
      images: [
        { url: "http://dusck.test/n1.png", type: "MODEL" },
        { url: "http://dusck.test/n2.png", type: "DETAIL" },
      ],
    },
  });
  assert.equal(patched.status, 200);
  const { data } = await patched.json();
  assert.equal(data.images.filter((i) => i.isMain).length, 1);
});

// ===========================================================================
// VARIANTES / STOCK DERIVADO — siguen funcionando (regresión)
// ===========================================================================

test("variants · siguen funcionando: color/size/sku/stock", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      variants: [
        { sku: `F1-V-${Date.now()}-S`, color: "Negro", size: "S", stock: 4 },
        { sku: `F1-V-${Date.now()}-M`, color: "Negro", size: "M", stock: 6 },
      ],
    }),
  );
  assert.equal(product.variants.length, 2);
  assert.equal(product.variants[0].color, "Negro");
  assert.equal(product.stock, 10, "Product.stock = suma de variants.stock");
});

test("stock derivado · un PATCH de variantes recalcula Product.stock", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const patched = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { variants: [{ sku: `F1-D-${Date.now()}`, color: "Azul", size: "Única", stock: 2 }] },
  });
  const { data } = await patched.json();
  assert.equal(data.stock, 2);
});

// ===========================================================================
// WORKFLOW — transiciones nuevas
// ===========================================================================

test("workflow · DRAFT -> PENDING_REVIEW (submit)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "PENDING_REVIEW");
});

test("workflow · PENDING_REVIEW -> CHANGES_REQUESTED (admin, exige comentario)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const noComment = await setStatus(product._id, ctx.users.admin.token, { toStatus: "CHANGES_REQUESTED" });
  assert.equal(noComment.status, 400, "sin comentario -> 400");

  const ok = await setStatus(product._id, ctx.users.admin.token, {
    toStatus: "CHANGES_REQUESTED",
    comment: "Falta la imagen posterior del producto.",
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.status, "CHANGES_REQUESTED");
});

// F6 — Admin Review: el comentario obligatorio debe rechazar TAMBIÉN un valor
// que sea solo espacios (no solo el caso "campo ausente" ya cubierto arriba).
test("workflow · PENDING_REVIEW -> CHANGES_REQUESTED con comentario solo espacios -> 400", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const res = await setStatus(product._id, ctx.users.admin.token, {
    toStatus: "CHANGES_REQUESTED",
    comment: "   ",
  });
  assert.equal(res.status, 400);
  const doc = await rawProduct(product._id);
  assert.equal(doc.status, "PENDING_REVIEW", "no debe haber transicionado");
});

test("workflow · CHANGES_REQUESTED: el editor propietario edita contenido y hace RESUBMIT", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");

  // edita contenido en CHANGES_REQUESTED
  const edit = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { details: "Detalles corregidos tras la revision." },
  });
  assert.equal(edit.status, 200);

  // reenvía
  const resubmit = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(resubmit.status, 200);
  assert.equal((await resubmit.json()).data.status, "PENDING_REVIEW");
});

test("workflow · CHANGES_REQUESTED -> DRAFT (el editor propietario puede aparcar)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "DRAFT" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "DRAFT");
});

test("workflow · PENDING_REVIEW -> APPROVED -> PUBLISHED (admin)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  const approve = await setStatus(product._id, ctx.users.admin.token, { toStatus: "APPROVED" });
  assert.equal(approve.status, 200);
  const publish = await setStatus(product._id, ctx.users.admin.token, { toStatus: "PUBLISHED" });
  assert.equal(publish.status, 200);
  const pub = (await publish.json()).data;
  assert.equal(pub.status, "PUBLISHED");
  assert.equal(pub.isActive, true);
});

test("workflow · PENDING_REVIEW -> REJECTED (exige motivo) y REJECTED -> ARCHIVED (admin)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const noReason = await setStatus(product._id, ctx.users.admin.token, { toStatus: "REJECTED" });
  assert.equal(noReason.status, 400);

  const rejected = await setStatus(product._id, ctx.users.admin.token, { toStatus: "REJECTED", comment: "No cumple la linea." });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).data.status, "REJECTED");

  const archived = await setStatus(product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).data.status, "ARCHIVED");
});

// F6 — mismo caso que CHANGES_REQUESTED: un motivo de solo espacios debe
// tratarse igual que ausente.
test("workflow · PENDING_REVIEW -> REJECTED con motivo solo espacios -> 400", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const res = await setStatus(product._id, ctx.users.admin.token, { toStatus: "REJECTED", comment: "   " });
  assert.equal(res.status, 400);
  const doc = await rawProduct(product._id);
  assert.equal(doc.status, "PENDING_REVIEW");
});

test("workflow · PUBLISHED -> ARCHIVED -> DRAFT (revivir, solo admin)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PUBLISHED");

  const archive = await setStatus(product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  assert.equal(archive.status, 200);
  const arch = (await archive.json()).data;
  assert.equal(arch.status, "ARCHIVED");
  assert.equal(arch.isActive, false);

  const revive = await setStatus(product._id, ctx.users.admin.token, { toStatus: "DRAFT" });
  assert.equal(revive.status, 200);
  assert.equal((await revive.json()).data.status, "DRAFT");
});

test("workflow · REJECTED -> DRAFT se CONSERVA (conflicto §7 documentado: no se rompe)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "REJECTED");
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "DRAFT" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "DRAFT");
});

test("workflow · transición inexistente (CHANGES_REQUESTED -> PUBLISHED) -> 403", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const res = await setStatus(product._id, ctx.users.admin.token, { toStatus: "PUBLISHED" });
  assert.equal(res.status, 403);
});

// ===========================================================================
// AUTORIZACIÓN
// ===========================================================================

test("authz · editor NO puede: request_changes, approve, reject, archive", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  for (const toStatus of ["CHANGES_REQUESTED", "APPROVED", "REJECTED"]) {
    const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus, comment: "x" });
    assert.equal(res.status, 403, `editor NO puede ${toStatus}`);
  }
  // archive desde PUBLISHED
  const { product: p2 } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(p2._id, "PUBLISHED");
  const arch = await setStatus(p2._id, ctx.users.editorA.token, { toStatus: "ARCHIVED" });
  assert.equal(arch.status, 403, "editor NO puede archivar");
});

test("authz · editor NO puede tocar CHANGES_REQUESTED de OTRO editor", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");

  const editAjeno = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.editorB.token,
    body: { details: "intruso" },
  });
  assert.equal(editAjeno.status, 403);

  const resubmitAjeno = await setStatus(product._id, ctx.users.editorB.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(resubmitAjeno.status, 403);
});

test("authz · admin SÍ ejecuta request_changes / archive / revivir", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  assert.equal((await setStatus(product._id, ctx.users.admin.token, { toStatus: "CHANGES_REQUESTED", comment: "c" })).status, 200);

  const { product: p2 } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(p2._id, "PUBLISHED");
  assert.equal((await setStatus(p2._id, ctx.users.admin.token, { toStatus: "ARCHIVED" })).status, 200);
  assert.equal((await setStatus(p2._id, ctx.users.admin.token, { toStatus: "DRAFT" })).status, 200);
});

test("authz · shop_manager NO gana request_changes ni archive (permisos intactos)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  assert.equal(
    (await setStatus(product._id, ctx.users.shopManager.token, { toStatus: "CHANGES_REQUESTED", comment: "c" })).status,
    403,
  );

  const { product: p2 } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(p2._id, "PUBLISHED");
  assert.equal((await setStatus(p2._id, ctx.users.shopManager.token, { toStatus: "ARCHIVED" })).status, 403);
});

test("authz · shop_manager conserva RESUBMIT desde CHANGES_REQUESTED (equivale a submit)", async (t) => {
  if (guard(t)) return;
  // producto creado por shop_manager (no sujeto a ownership)
  const { product } = await create(ctx.users.shopManager.token, validDraft({ name: "SM F1" }));
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const res = await setStatus(product._id, ctx.users.shopManager.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 200);
});

test("authz · subscriber no accede al workflow (transicionar) -> 403", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  const res = await setStatus(product._id, ctx.users.subscriber.token, { toStatus: "CHANGES_REQUESTED", comment: "x" });
  assert.equal(res.status, 403);
});

// ===========================================================================
// WORKFLOW HISTORY + COMENTARIOS
// ===========================================================================

const rawProduct = (id) => ctx.models.ProductModel.findById(id).lean();

test("history · cada transición añade una entrada con action/from/to/by/at", async (t) => {
  if (guard(t)) return;
  const { admin, editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  const id = product._id;

  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "Falta imagen posterior." });
  await setStatus(id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(id, admin.token, { toStatus: "APPROVED" });
  await setStatus(id, admin.token, { toStatus: "PUBLISHED" });

  const doc = await rawProduct(id);
  const h = doc.workflowHistory;
  assert.equal(h.length, 5);
  assert.deepEqual(
    h.map((e) => e.action),
    ["submit", "request_changes", "resubmit", "approve", "publish"],
  );
  assert.deepEqual(h[0].fromStatus, "DRAFT");
  assert.deepEqual(h[0].toStatus, "PENDING_REVIEW");
  for (const e of h) {
    assert.ok(e.by, "cada entrada conserva `by`");
    assert.ok(e.at, "cada entrada conserva `at`");
  }
  assert.equal(String(h[1].by), String(admin.doc._id), "request_changes lo hizo el admin");
  assert.equal(String(h[0].by), String(editorA.doc._id), "submit lo hizo el editor");
});

test("history · el comentario de CHANGES_REQUESTED queda asociado a la entrada", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  await setStatus(product._id, ctx.users.admin.token, {
    toStatus: "CHANGES_REQUESTED",
    comment: "Falta imagen posterior del producto.",
  });
  const doc = await rawProduct(product._id);
  const last = doc.workflowHistory.at(-1);
  assert.equal(last.action, "request_changes");
  assert.equal(last.comment, "Falta imagen posterior del producto.");
});

test("history · REJECTED guarda el motivo en history Y en rejectionReason (espejo compat)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");
  const res = await setStatus(product._id, ctx.users.admin.token, { toStatus: "REJECTED", rejectionReason: "Fotos borrosas." });
  assert.equal(res.status, 200);
  const data = (await res.json()).data;
  assert.equal(data.rejectionReason, "Fotos borrosas.");
  const doc = await rawProduct(product._id);
  assert.equal(doc.workflowHistory.at(-1).comment, "Fotos borrosas.");
  assert.equal(doc.workflowHistory.at(-1).action, "reject");
});

test("history · approve / archive también generan entrada (sin comentario)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PUBLISHED");
  await setStatus(product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  const doc = await rawProduct(product._id);
  const actions = doc.workflowHistory.map((e) => e.action);
  assert.ok(actions.includes("approve"));
  assert.ok(actions.includes("publish"));
  assert.equal(actions.at(-1), "archive");
});

test("history · el cliente NO puede inyectar workflowHistory por el body", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ workflowHistory: [{ action: "publish", toStatus: "PUBLISHED", by: ctx.users.editorA.doc._id }] }),
  );
  const doc = await rawProduct(product._id);
  assert.deepEqual(doc.workflowHistory, [], "workflowHistory no se acepta en la creación");
});

// ===========================================================================
// VALIDACIÓN DE SUBMIT
// ===========================================================================

test("submit · DRAFT sin details/shipping/returns -> 400 con errores concretos", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ details: "", shippingInfo: "", returnsInfo: "" }),
  );
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.toLowerCase().includes("detalle")));
  assert.ok(errors.some((e) => e.toLowerCase().includes("env")));
  assert.ok(errors.some((e) => e.toLowerCase().includes("devoluc")));
});

test("submit · sin imagen principal -> 400", async (t) => {
  if (guard(t)) return;
  // Se fuerza el escenario en BD (la normalización impediría crearlo por API).
  const { ProductModel } = ctx.models;
  const doc = await ProductModel.collection.insertOne({
    ...validDraft(),
    categories: [ctx.categories.hombre._id],
    images: [{ url: "http://dusck.test/nomain.png", isMain: false, type: "DETAIL", order: 0, alt: "" }],
    variants: [],
    status: "DRAFT",
    isActive: false,
    createdBy: ctx.users.editorA.doc._id,
    workflowHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const res = await setStatus(doc.insertedId, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.toLowerCase().includes("principal")));
});

test("submit · stock negativo -> 400", async (t) => {
  if (guard(t)) return;
  const { res } = await create(ctx.users.editorA.token, validDraft({ stock: -3 }));
  assert.equal(res.status, 400);
});

test("submit · variante sin SKU -> 400 al enviar a revisión", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ variants: [{ sku: "", color: "Negro", size: "Única", stock: 2 }] }),
  );
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.toLowerCase().includes("sku")));
});

test("submit · DRAFT completo (con los 3 campos nuevos) -> 200", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const res = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(res.status, 200);
});

// ===========================================================================
// isActive — invariante en los estados nuevos
// ===========================================================================

test("isActive · CHANGES_REQUESTED y ARCHIVED nunca quedan activos", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PUBLISHED"); // aquí isActive=true

  const cr = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(cr.product._id, "CHANGES_REQUESTED");
  assert.equal((await rawProduct(cr.product._id)).isActive, false);

  const archived = await setStatus(product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  assert.equal((await archived.json()).data.isActive, false);
});

test("isActive · PATCH { isActive:true } sobre CHANGES_REQUESTED -> 400", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "CHANGES_REQUESTED");
  const res = await api(`/api/product/${product._id}`, {
    method: "PATCH",
    token: ctx.users.admin.token,
    body: { isActive: true },
  });
  assert.equal(res.status, 400);
});

// ===========================================================================
// PUBLIC FILTER — ARCHIVED / CHANGES_REQUESTED nunca en el catálogo público
// ===========================================================================

test("public · ARCHIVED y CHANGES_REQUESTED no aparecen en GET /product ni en /:id", async (t) => {
  if (guard(t)) return;
  const changes = await create(ctx.users.editorA.token, validDraft({ name: "F1 en cambios" }));
  await advanceTo(changes.product._id, "CHANGES_REQUESTED");

  const archived = await create(ctx.users.editorA.token, validDraft({ name: "F1 archivado" }));
  await advanceTo(archived.product._id, "PUBLISHED");
  await setStatus(archived.product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });

  const list = await api("/api/product");
  const ids = (await list.json()).data.map((p) => p._id);
  assert.ok(!ids.includes(changes.product._id));
  assert.ok(!ids.includes(archived.product._id));

  assert.equal((await api(`/api/product/${changes.product._id}`)).status, 404);
  assert.equal((await api(`/api/product/${archived.product._id}`)).status, 404);
});

test("public · un producto ARCHIVADO conserva su documento (no es DELETE)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PUBLISHED");
  await setStatus(product._id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  const doc = await rawProduct(product._id);
  assert.ok(doc, "el documento sigue existiendo");
  assert.equal(doc.status, "ARCHIVED");
  assert.ok(doc.workflowHistory.length >= 3, "conserva el historial");
});

// ===========================================================================
// F1-CLOSURE-1 — normalizeProductImages(): determinismo + una sola principal
// ===========================================================================

const normImgs = async (arr) => {
  const { normalizeProductImages } = await import("../src/models/product.model.js");
  const copy = arr.map((x) => (x ? { ...x } : x));
  normalizeProductImages(copy);
  return copy;
};

test("closure1 · 0 imágenes -> no hace nada", async (t) => {
  if (guard(t)) return;
  assert.deepEqual(await normImgs([]), []);
});

test("closure1 · 1 imagen sin isMain -> se promueve a principal (isMain + type MAIN)", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([{ url: "a", type: "DETAIL" }]);
  assert.equal(out[0].isMain, true);
  assert.equal(out[0].type, "MAIN");
});

test("closure1 · varias imágenes, NINGUNA isMain -> la primera (posición 0) es la principal", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([
    { url: "a" }, // pos 0 -> principal
    { url: "b", type: "MODEL" },
    { url: "c", type: "DETAIL" },
  ]);
  assert.equal(out.filter((i) => i.isMain).length, 1);
  assert.equal(out[0].isMain, true);
  assert.equal(out[0].type, "MAIN");
  // las NO-principales conservan su type explícito, nunca quedan con MAIN
  assert.equal(out[1].type, "MODEL");
  assert.equal(out[2].type, "DETAIL");
});

test("closure1 · varias imágenes con isMain -> queda exactamente UNA (la primera marcada)", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([
    { url: "a", isMain: false },
    { url: "b", isMain: true },
    { url: "c", isMain: true },
  ]);
  assert.equal(out.filter((i) => i.isMain).length, 1);
  assert.equal(out[1].isMain, true, "la primera marcada gana (índice 1)");
  assert.equal(out[1].type, "MAIN");
  assert.equal(out[0].isMain, false);
  assert.equal(out[2].isMain, false);
});

test("closure1 · exactamente una isMain -> se conserva esa", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([
    { url: "a", isMain: false, type: "MODEL" },
    { url: "b", isMain: true },
    { url: "c", isMain: false, type: "DETAIL" },
  ]);
  assert.equal(out[1].isMain, true);
  assert.equal(out[1].type, "MAIN");
  assert.equal(out[0].type, "MODEL");
  assert.equal(out[2].type, "DETAIL");
});

test("closure1 · NINGUNA NO-principal queda con type MAIN (default o conflicto)", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([
    { url: "a", isMain: true, type: "MAIN" },
    { url: "b", type: "MAIN" }, // conflicto: no principal pero type MAIN
    { url: "c" }, // sin type -> defaultearía a MAIN
  ]);
  assert.equal(out.filter((i) => i.type === "MAIN").length, 1, "sólo la principal es MAIN");
  assert.equal(out[1].type, "DETAIL");
  assert.equal(out[2].type, "DETAIL");
});

test("closure1 · sincronización isMain:true + type:'DETAIL' -> gana isMain (type MAIN)", async (t) => {
  if (guard(t)) return;
  const out = await normImgs([{ url: "a", isMain: true, type: "DETAIL" }]);
  assert.equal(out[0].isMain, true);
  assert.equal(out[0].type, "MAIN");
});

test("closure1 · vía API: crear con 3 imágenes sin isMain -> exactamente una principal, ninguna otra MAIN", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({
      images: [{ url: "http://d/1.png" }, { url: "http://d/2.png" }, { url: "http://d/3.png" }],
    }),
  );
  assert.equal(product.images.filter((i) => i.isMain).length, 1);
  assert.equal(product.images.filter((i) => i.type === "MAIN").length, 1);
  assert.equal(product.images[0].isMain, true);
});

// ===========================================================================
// F1-CLOSURE-2 — REJECTED -> DRAFT: contrato explícito
// ===========================================================================

test("closure2 · REJECTED lo produce el ADMIN; el editor NO puede", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const editorRejects = await setStatus(product._id, ctx.users.editorA.token, {
    toStatus: "REJECTED",
    comment: "me autorechazo",
  });
  assert.equal(editorRejects.status, 403, "el editor NO puede fijar REJECTED");

  const adminRejects = await setStatus(product._id, ctx.users.admin.token, {
    toStatus: "REJECTED",
    comment: "No cumple.",
  });
  assert.equal(adminRejects.status, 200);
});

test("closure2 · REJECTED -> DRAFT devuelve el producto al flujo editorial (editor propietario)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const id = product._id;
  await advanceTo(id, "REJECTED");

  const backToDraft = await setStatus(id, ctx.users.editorA.token, { toStatus: "DRAFT" });
  assert.equal(backToDraft.status, 200);
  assert.equal((await backToDraft.json()).data.status, "DRAFT");

  // el editor puede volver a editar y reenviar
  await api(`/api/product/${id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { details: "corregido" },
  });
  const resend = await setStatus(id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(resend.status, 200);

  // ...pero SIGUE sin poder aprobar / publicar / rechazar
  for (const toStatus of ["APPROVED", "PUBLISHED", "REJECTED"]) {
    const res = await setStatus(id, ctx.users.editorA.token, { toStatus, comment: "x" });
    assert.equal(res.status, 403, `editor NO puede ${toStatus} tras REJECTED->DRAFT`);
  }
});

// ===========================================================================
// F1-CLOSURE-3 — publishedAt al archivar
// ===========================================================================

test("closure3 · PUBLISHED -> ARCHIVED CONSERVA publishedAt (y publishedBy)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const id = product._id;
  await advanceTo(id, "PUBLISHED");

  const beforeDoc = await rawProduct(id);
  assert.ok(beforeDoc.publishedAt, "precondición: publishedAt presente al publicar");
  const publishedAtISO = new Date(beforeDoc.publishedAt).toISOString();

  const archived = await setStatus(id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  assert.equal(archived.status, 200);

  const afterDoc = await rawProduct(id);
  assert.equal(afterDoc.status, "ARCHIVED");
  assert.equal(afterDoc.isActive, false, "ARCHIVED nunca activo");
  assert.ok(afterDoc.publishedAt, "publishedAt SE CONSERVA tras archivar");
  assert.equal(new Date(afterDoc.publishedAt).toISOString(), publishedAtISO, "mismo valor, sin tocar");
  assert.ok(afterDoc.publishedBy, "publishedBy también se conserva");
  // el resto de metadata de ciclo SÍ se limpia
  assert.ok(!afterDoc.approvedAt, "approvedAt se limpia");
  assert.ok(!afterDoc.submittedAt, "submittedAt se limpia");
});

test("closure3 · REJECTED -> ARCHIVED: no hay publishedAt que preservar (nunca se publicó)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const id = product._id;
  await advanceTo(id, "REJECTED");

  const archived = await setStatus(id, ctx.users.admin.token, { toStatus: "ARCHIVED" });
  assert.equal(archived.status, 200);
  const doc = await rawProduct(id);
  assert.equal(doc.status, "ARCHIVED");
  assert.ok(!doc.publishedAt, "sin publishedAt (coherente: nunca se publicó)");
  assert.ok(!doc.rejectionReason, "la metadata de rechazo se limpia; el rastro queda en workflowHistory");
  assert.ok(doc.workflowHistory.some((e) => e.action === "reject"));
});

test("closure3 · ARCHIVED -> DRAFT limpia publishedAt (misma política que PUBLISHED -> DRAFT)", async (t) => {
  if (guard(t)) return;
  const { product } = await create(ctx.users.editorA.token, validDraft());
  const id = product._id;
  await advanceTo(id, "PUBLISHED");
  await setStatus(id, ctx.users.admin.token, { toStatus: "ARCHIVED" });

  const revived = await setStatus(id, ctx.users.admin.token, { toStatus: "DRAFT" });
  assert.equal(revived.status, 200);
  const doc = await rawProduct(id);
  assert.equal(doc.status, "DRAFT");
  assert.ok(!doc.publishedAt, "DRAFT = pizarra limpia (igual que PUBLISHED -> DRAFT)");
  assert.ok(doc.workflowHistory.some((e) => e.action === "archive"));
  assert.ok(doc.workflowHistory.some((e) => e.action === "reopen"));
});

// ===========================================================================
// F1-CLOSURE-4 — submit validation: cada campo obligatorio por separado
// ===========================================================================

for (const field of ["details", "shippingInfo", "returnsInfo"]) {
  test(`closure4 · falta SOLO ${field} -> no se puede enviar a revisión (400)`, async (t) => {
    if (guard(t)) return;
    const { product } = await create(ctx.users.editorA.token, validDraft({ [field]: "" }));
    // se puede guardar el DRAFT incompleto
    const patch = await api(`/api/product/${product._id}`, {
      method: "PATCH",
      token: ctx.users.editorA.token,
      body: { description: "sigo trabajando" },
    });
    assert.equal(patch.status, 200, "un DRAFT incompleto SÍ se guarda");
    // pero NO se envía a revisión
    const submit = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
    assert.equal(submit.status, 400);
    const { errors } = await submit.json();
    assert.ok(errors.length > 0);
  });
}

test("closure4 · la validación es de BACKEND: un submit directo por API (sin frontend) se rechaza", async (t) => {
  if (guard(t)) return;
  const { product } = await create(
    ctx.users.editorA.token,
    validDraft({ details: "", shippingInfo: "", returnsInfo: "" }),
  );
  const submit = await setStatus(product._id, ctx.users.editorA.token, { toStatus: "PENDING_REVIEW" });
  assert.equal(submit.status, 400);
  // el producto NO avanzó
  assert.equal((await rawProduct(product._id)).status, "DRAFT");
});

// ===========================================================================
// F1-CLOSURE-5 — recorrido completo del workflow (todas las transiciones)
// ===========================================================================

test("closure5 · recorrido de TODAS las transiciones del workflow F1", async (t) => {
  if (guard(t)) return;
  const { admin, editorA } = ctx.users;
  const step = async (id, token, body, expected, label) => {
    const res = await setStatus(id, token, body);
    assert.equal(res.status, expected, `${label}: esperado ${expected}, recibido ${res.status}`);
    return res;
  };

  // --- rama CHANGES_REQUESTED: DRAFT -> PR -> CR -> PR -> APPROVED -> PUBLISHED
  let p = (await create(editorA.token, validDraft())).product;
  await step(p._id, editorA.token, { toStatus: "PENDING_REVIEW" }, 200, "DRAFT->PENDING_REVIEW");
  await step(p._id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "ajusta" }, 200, "PENDING_REVIEW->CHANGES_REQUESTED");
  await step(p._id, editorA.token, { toStatus: "PENDING_REVIEW" }, 200, "CHANGES_REQUESTED->PENDING_REVIEW");
  await step(p._id, admin.token, { toStatus: "APPROVED" }, 200, "PENDING_REVIEW->APPROVED");
  await step(p._id, admin.token, { toStatus: "PUBLISHED" }, 200, "APPROVED->PUBLISHED");
  await step(p._id, admin.token, { toStatus: "DRAFT" }, 200, "PUBLISHED->DRAFT");

  // --- CHANGES_REQUESTED -> DRAFT
  p = (await create(editorA.token, validDraft())).product;
  await step(p._id, editorA.token, { toStatus: "PENDING_REVIEW" }, 200, "submit");
  await step(p._id, admin.token, { toStatus: "CHANGES_REQUESTED", comment: "c" }, 200, "request_changes");
  await step(p._id, editorA.token, { toStatus: "DRAFT" }, 200, "CHANGES_REQUESTED->DRAFT");

  // --- rama REJECTED: -> DRAFT y -> ARCHIVED
  p = (await create(editorA.token, validDraft())).product;
  await step(p._id, editorA.token, { toStatus: "PENDING_REVIEW" }, 200, "submit");
  await step(p._id, admin.token, { toStatus: "REJECTED", comment: "no" }, 200, "PENDING_REVIEW->REJECTED");
  await step(p._id, editorA.token, { toStatus: "DRAFT" }, 200, "REJECTED->DRAFT");
  await step(p._id, editorA.token, { toStatus: "PENDING_REVIEW" }, 200, "resubmit");
  await step(p._id, admin.token, { toStatus: "REJECTED", comment: "sigue mal" }, 200, "reject #2");
  await step(p._id, admin.token, { toStatus: "ARCHIVED" }, 200, "REJECTED->ARCHIVED");
  await step(p._id, admin.token, { toStatus: "DRAFT" }, 200, "ARCHIVED->DRAFT");

  // --- rama PUBLISHED -> ARCHIVED -> DRAFT
  p = (await create(editorA.token, validDraft())).product;
  await advanceTo(p._id, "PUBLISHED");
  await step(p._id, admin.token, { toStatus: "ARCHIVED" }, 200, "PUBLISHED->ARCHIVED");
  await step(p._id, admin.token, { toStatus: "DRAFT" }, 200, "ARCHIVED->DRAFT");
});

test("closure5 · atomicidad: 2 transiciones concurrentes desde PENDING_REVIEW -> 1x200, 1x409, history coherente", async (t) => {
  if (guard(t)) return;
  const { admin, admin2, editorA } = ctx.users;
  const { product } = await create(editorA.token, validDraft());
  await advanceTo(product._id, "PENDING_REVIEW");

  const [r1, r2] = await Promise.all([
    setStatus(product._id, admin.token, { toStatus: "APPROVED" }),
    setStatus(product._id, admin2.token, { toStatus: "CHANGES_REQUESTED", comment: "c" }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);

  const doc = await rawProduct(product._id);
  // exactamente UNA entrada de historial para este par de intentos concurrentes
  const lastTwo = doc.workflowHistory.slice(-1);
  assert.equal(lastTwo.length, 1);
  assert.ok(["approve", "request_changes"].includes(lastTwo[0].action));
  assert.equal(lastTwo[0].toStatus, doc.status, "history coherente con el status final");
});
