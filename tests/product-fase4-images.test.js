// FASE 4 — Imágenes reales / Cloudinary (upload intermediado por backend).
//
// Cubre EXCLUSIVAMENTE lo nuevo de FASE 4:
//   · POST   /product/:id/images         (upload real)
//   · DELETE /product/:id/images/:imageId (borrado real)
//   · reconciliación de `publicId` en PATCH /product/:id (nunca confiar en el
//     que mande el cliente; nunca perderlo en un guardado normal)
//   · límites (tamaño, cantidad, dimensiones), validación de contenido real
//     (magic bytes / extensión), autorización (rol + ownership + estado),
//     manejo de fallos de Cloudinary, integridad de MAIN/type/order/alt,
//     y que ningún secreto/publicId ajeno se filtre.
//
// Cloudinary NUNCA se llama de verdad: `cloudinaryImageService.upload/destroy`
// se stubean con `t.mock.method` (mismo patrón que `ProductModel.findOneAndUpdate`
// en order-service.test.js / product-inventory-ops.test.js) — así la suite no
// depende de red ni de credenciales reales, y puede simular éxito/fallo/timeout
// de forma determinista.
//
// BD APARTE: `db-dusck-fase4-images-test`. Sin Mongo -> suite `skip`.
//
// Ejecutar:  node --test tests/product-fase4-images.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-fase4-images-test";
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-fase4-images";

let ctx = null;
let mongoAvailable = true;

// --- Fixtures binarios --------------------------------------------------
// Construidos a mano (sin librerías de imagen): solo necesitan ser
// estructuralmente correctos en los bytes que `imageUpload.helper.js`
// realmente inspecciona (firma + cabecera de dimensiones). No son imágenes
// renderizables completas (sin IDAT/CRC reales) — Cloudinary está mockeado y
// nunca decodifica el buffer de verdad; lo único bajo prueba es NUESTRA
// validación.

function jpegBuffer(width, height, totalLen = 64) {
  const buf = Buffer.alloc(Math.max(totalLen, 16));
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(11, 4); // longitud de segmento (arbitraria, no se usa)
  buf[6] = 0x08; // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function pngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((b, i) => (buf[i] = b));
  buf.writeUInt32BE(13, 8); // longitud del chunk IHDR
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type (RGB)
  return buf;
}

function webpBuffer(width, height) {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16); // tamaño del chunk VP8X
  buf[20] = 0x10; // flags
  // bytes 21-23 reservados = 0
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

// JPEG "corrupto": firma válida, pero truncado antes de poder leer las
// dimensiones -> `readImageDimensions` debe devolver null.
function corruptJpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

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
    const { cloudinaryImageService } = await import("../src/services/cloudinaryImage.service.js");
    const cloudinaryConfig = await import("../src/config/cloudinary.config.js");

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

    const admin = await makeUser({ name: "Admin F4", nickname: "admin-f4", email: "admin-f4@dusck.com", role: "administrador" });
    const shopManager = await makeUser({ name: "Shop F4", nickname: "shop-f4", email: "shop-f4@dusck.com", role: "shop_manager" });
    const editorA = await makeUser({ name: "Editor A F4", nickname: "editor-a-f4", email: "editor-a-f4@dusck.com", role: "editor" });
    const editorB = await makeUser({ name: "Editor B F4", nickname: "editor-b-f4", email: "editor-b-f4@dusck.com", role: "editor" });
    const subscriber = await makeUser({ name: "Sub F4", nickname: "sub-f4", email: "sub-f4@dusck.com", role: "subscriber" });

    const category = await CategoryModel.create({ name: "Hombre F4", slug: "hombre-f4" });

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
      cloudinaryImageService,
      cloudinaryConfig,
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[product-fase4-images] MongoDB no disponible, se omite la suite: ${err.name} ${err.message}`);
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

const apiJson = (path, { method = "GET", body, token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// Upload multipart real vía fetch (Node 24 trae FormData/Blob nativos).
const uploadImage = (productId, { token, buffer, filename = "foto.jpg", mimeType = "image/jpeg" } = {}) => {
  const form = new FormData();
  if (buffer !== null) {
    form.append("image", new Blob([buffer], { type: mimeType }), filename);
  }
  return fetch(`${ctx.base}/api/product/${productId}/images`, {
    method: "POST",
    headers: token ? { "x-token": token } : {},
    body: form,
  });
};

const deleteImage = (productId, imageId, token) =>
  fetch(`${ctx.base}/api/product/${productId}/images/${imageId}`, {
    method: "DELETE",
    headers: token ? { "x-token": token } : {},
  });

const validDraft = (over = {}) => ({
  name: "Producto F4",
  slug: `producto-f4-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion suficiente.",
  price: 50000,
  stock: 5,
  categories: [ctx.category._id.toString()],
  images: [],
  ...over,
});

const createDraft = async (token, over = {}) => {
  const res = await apiJson("/api/product", { method: "POST", token, body: validDraft(over) });
  const json = await res.json();
  return json.data;
};

const setStatus = (id, token, body) => apiJson(`/api/product/${id}/status`, { method: "PATCH", token, body });

// Stub estándar: éxito determinista, publicId único por llamada.
let uploadCounter = 0;
const stubCloudinaryUploadSuccess = (t, { width = 400, height = 400 } = {}) => {
  t.mock.method(ctx.cloudinaryImageService, "upload", async () => {
    uploadCounter += 1;
    return {
      url: `https://res.cloudinary.test/dusck/products/fake-${uploadCounter}.jpg`,
      publicId: `dusck/products/fake-${uploadCounter}`,
      width,
      height,
    };
  });
};

const destroyCalls = [];
const stubCloudinaryDestroy = (t) => {
  destroyCalls.length = 0;
  t.mock.method(ctx.cloudinaryImageService, "destroy", async (publicId) => {
    destroyCalls.push(publicId);
    return true;
  });
};

// ===========================================================================
// AUTHORIZATION
// ===========================================================================

test("F4 authz: subscriber no puede subir imagenes", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, subscriber } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: subscriber.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 403);
});

test("F4 authz: editor propietario en DRAFT puede subir", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.images.length, 1);
});

test("F4 authz: editor NO propietario no puede subir imagenes al producto de otro editor", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, editorB } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorB.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 403);
});

test("F4 authz: editor NO puede subir imagenes en estado no editable (PENDING_REVIEW)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token, {
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
    images: [{ url: "http://dusck.test/x.png", isMain: true }],
  });
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 403);
});

test("F4 authz: admin puede subir imagenes a cualquier producto en estado editable", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, admin } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: admin.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 200);
});

test("F4 authz: administrador SI puede subir imagenes a un producto PUBLISHED (autoridad de contenido siempre, ver editableFieldsFor)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, admin } = ctx.users;
  const product = await createDraft(editorA.token, {
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
    images: [{ url: "http://dusck.test/pub.png", isMain: true }],
  });
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  // `editableFieldsFor` (productWorkflow.helper.js) le da a `administrador`
  // contenido editable SIEMPRE, sin importar el estado — misma regla que ya
  // rige PATCH /product/:id. El endpoint de imágenes reutiliza exactamente
  // esa función, así que hereda el mismo comportamiento (no es un atajo).
  const res = await uploadImage(product._id, { token: admin.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 200);
});

test("F4 authz: editor propietario NO puede subir imagenes a su PROPIO producto PUBLISHED sin reabrir (edicion controlada)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, admin } = ctx.users;
  const product = await createDraft(editorA.token, {
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
    images: [{ url: "http://dusck.test/pub2.png", isMain: true }],
  });
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 403);
});

test("F4 authz: shop_manager sigue la misma regla de contenido que editor (bloqueado en PENDING_REVIEW)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, shopManager } = ctx.users;
  const product = await createDraft(editorA.token, {
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
    images: [{ url: "http://dusck.test/sm.png", isMain: true }],
  });
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });

  const res = await uploadImage(product._id, { token: shopManager.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 403);
});

test("F4 authz: upload sin token responde 401", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 401);
});

// ===========================================================================
// VALIDATION
// ===========================================================================

test("F4 validation: JPEG valido se acepta", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: jpegBuffer(300, 300),
    filename: "foto.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(res.status, 200);
});

test("F4 validation: PNG valido se acepta", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: pngBuffer(300, 300),
    filename: "foto.png",
    mimeType: "image/png",
  });
  assert.equal(res.status, 200);
});

test("F4 validation: WEBP valido se acepta", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: webpBuffer(300, 300),
    filename: "foto.webp",
    mimeType: "image/webp",
  });
  assert.equal(res.status, 200);
});

test("F4 validation: MIME invalido (declarado) se rechaza en el borde multer", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: Buffer.from("no soy una imagen"),
    filename: "archivo.txt",
    mimeType: "text/plain",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /no permitido/i);
});

test("F4 validation: MIME spoofing — Content-Type image/jpeg pero bytes reales no son ninguna imagen soportada", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: Buffer.from("MZ\x90\x00esto-no-es-una-imagen-real-son-bytes-cualquiera"),
    filename: "disfrazado.jpg",
    mimeType: "image/jpeg", // el navegador "miente" — la firma real no es JPEG
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /no permitido/i);
});

test("F4 validation: extension no coincide con el contenido real (PNG real con extension .jpg)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: pngBuffer(300, 300),
    filename: "foto.jpg", // extensión mentirosa: el contenido real es PNG
    mimeType: "image/jpeg", // multer deja pasar el Content-Type declarado…
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /extensión/i);
});

test("F4 validation: archivo demasiado grande se rechaza (limite 8MB)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const big = jpegBuffer(300, 300, 8 * 1024 * 1024 + 1024);
  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: big,
    filename: "grande.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /tamaño máximo/i);
});

test("F4 validation: archivo corrupto (firma valida, dimensiones ilegibles) se rechaza", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: corruptJpegBuffer(),
    filename: "roto.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /dañad|procesar/i);
});

test("F4 validation: imagen demasiado pequeña se rechaza (minimo 200x200)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: jpegBuffer(50, 50),
    filename: "chica.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /pequeña/i);
});

test("F4 validation: imagen con dimensiones excesivas se rechaza (maximo 6000x6000)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, {
    token: editorA.token,
    buffer: jpegBuffer(7000, 7000),
    filename: "enorme.jpg",
    mimeType: "image/jpeg",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.msg, /dimensiones máximas/i);
});

test("F4 validation: sin archivo adjunto responde 400", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: null });
  assert.equal(res.status, 400);
});

test("F4 validation: exceso de imagenes (limite 10 por producto)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  for (let i = 0; i < 10; i++) {
    const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
    assert.equal(res.status, 200, `upload #${i + 1} debería aceptarse`);
  }

  const res11 = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res11.status, 400);
  const json = await res11.json();
  assert.match(json.msg, /máximo de imágenes/i);
});

// ===========================================================================
// CLOUDINARY (exito / fallo / timeout / respuesta invalida)
// ===========================================================================

test("F4 cloudinary: fallo/timeout de Cloudinary no deja el producto en estado inconsistente", async (t) => {
  if (guard(t)) return;
  t.mock.method(ctx.cloudinaryImageService, "upload", async () => {
    throw new Error("simulated network timeout");
  });
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.msg, /no fue posible subir/i);
  // No debe haber quedado ninguna referencia falsa en Mongo.
  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.images.length, 0);
});

test("F4 cloudinary: servicio no configurado responde con error generico (sin detalles internos)", async (t) => {
  if (guard(t)) return;
  t.mock.method(ctx.cloudinaryImageService, "upload", async () => {
    const err = new Error("El servicio de imagenes no esta configurado");
    err.code = "CLOUDINARY_NOT_CONFIGURED";
    throw err;
  });
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.doesNotMatch(json.msg, /cloudinary/i);
  assert.doesNotMatch(json.msg, /CLOUDINARY_NOT_CONFIGURED/);
});

test("F4 cloudinary: respuesta invalida de upload_stream se traduce a rechazo, nunca a un crash", async (t) => {
  if (guard(t)) return;
  const cloudinaryModule = await import("../src/config/cloudinary.config.js");
  const { env } = await import("../src/config/env.config.js");

  // `assertCloudinaryConfigured` es una función exportada de un módulo ESM
  // (binding no reconfigurable: `t.mock.method` no puede stubearla
  // directamente). En vez de mockearla, se satisface de verdad: se rellenan
  // credenciales dummy en el objeto `env` (mutable en memoria, nunca se
  // escribe a disco/proceso real) para que la función pase sin lanzar, y solo
  // se stubea la llamada de red real (`upload_stream`).
  const original = { ...env.cloudinary };
  env.cloudinary.cloudName = "dummy";
  env.cloudinary.apiKey = "dummy";
  env.cloudinary.apiSecret = "dummy";
  t.after(() => Object.assign(env.cloudinary, original));

  t.mock.method(cloudinaryModule.cloudinary.uploader, "upload_stream", (options, callback) => {
    // Simula la SDK devolviendo `result: null` sin error explícito.
    callback(null, null);
    return { end: () => {} };
  });

  const { cloudinaryImageService } = await import("../src/services/cloudinaryImage.service.js");
  await assert.rejects(() => cloudinaryImageService.upload(Buffer.from("x"), "folder"));
});

// ===========================================================================
// PRODUCT INTEGRITY (URL, metadata, MAIN, type, order, alt, normalizacion)
// ===========================================================================

test("F4 integrity: primera imagen subida se marca MAIN/type=MAIN automaticamente", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  const json = await res.json();
  assert.equal(json.data.images.length, 1);
  assert.equal(json.data.images[0].isMain, true);
  assert.equal(json.data.images[0].type, "MAIN");
  assert.equal(json.data.images[0].order, 0);
  assert.equal(json.data.images[0].alt, "");
  assert.ok(json.data.images[0].url.startsWith("https://res.cloudinary.test/"));
});

test("F4 integrity: segunda imagen subida NO toca la principal existente", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  const res2 = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  const json2 = await res2.json();

  assert.equal(json2.data.images.length, 2);
  const mains = json2.data.images.filter((i) => i.isMain);
  assert.equal(mains.length, 1);
  assert.equal(json2.data.images[0].isMain, true);
  assert.equal(json2.data.images[1].isMain, false);
  assert.equal(json2.data.images[1].type, "DETAIL");
});

test("F4 integrity: borrar la imagen principal promueve la posicion 0 restante a MAIN", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const r1 = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const r2 = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const mainImageId = r1.data.images[0]._id;
  const secondImageId = r2.data.images[1]._id;

  const delRes = await deleteImage(product._id, mainImageId, editorA.token);
  assert.equal(delRes.status, 200);
  const delJson = await delRes.json();

  assert.equal(delJson.data.images.length, 1);
  assert.equal(delJson.data.images[0]._id, secondImageId);
  assert.equal(delJson.data.images[0].isMain, true);
  assert.equal(delJson.data.images[0].type, "MAIN");
});

test("F4 integrity: borrar una imagen NO principal conserva la principal intacta", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const r1 = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const r2 = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const mainImageId = r1.data.images[0]._id;
  const secondImageId = r2.data.images[1]._id;

  const delRes = await deleteImage(product._id, secondImageId, editorA.token);
  const delJson = await delRes.json();

  assert.equal(delJson.data.images.length, 1);
  assert.equal(delJson.data.images[0]._id, mainImageId);
  assert.equal(delJson.data.images[0].isMain, true);
});

test("F4 integrity: PATCH normal de contenido preserva el publicId de una imagen subida por F4", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const uploaded = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const uploadedImage = uploaded.data.images[0];

  // El editor edita SOLO el `alt` vía el PATCH normal (igual que hace Angular:
  // reenvía el array completo de imágenes con lo que ya tenía + su cambio).
  const patchRes = await apiJson(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: {
      images: [{ url: uploadedImage.url, isMain: true, type: "MAIN", order: 0, alt: "Editado" }],
    },
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.data.images[0].alt, "Editado");

  // No debe haberse disparado ningún cleanup: el publicId sigue asociado (la
  // URL coincide con la ya persistida).
  assert.equal(destroyCalls.length, 0);

  const raw = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(raw.images[0].publicId, uploadedImage.publicId ?? raw.images[0].publicId);
  assert.ok(raw.images[0].publicId, "publicId debe seguir presente tras el PATCH normal");
});

test("F4 integrity: quitar una imagen via PATCH normal dispara cleanup best-effort en Cloudinary", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  const before = await ctx.models.ProductModel.findById(product._id).lean();
  const persistedPublicId = before.images[0].publicId;
  assert.ok(persistedPublicId);

  const patchRes = await apiJson(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { images: [] },
  });
  assert.equal(patchRes.status, 200);

  assert.ok(destroyCalls.includes(persistedPublicId));
});

// ===========================================================================
// CONCURRENCY (F4-CLOSURE §2/§3 — carreras de integridad de MAIN y de
// límite máximo bajo uploads simultáneos al MISMO producto). Ver el
// comentario extenso en `dbAddProductImage` (product.services.js) para la
// estrategia atómica de dos intentos que estos tests verifican.
// ===========================================================================

test("F4 concurrency: N uploads simultaneos a un producto vacio -> exactamente UNA imagen queda isMain:true", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const N = 6;
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) }),
    ),
  );
  for (const res of responses) assert.equal(res.status, 200);

  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.images.length, N);
  const mains = fresh.images.filter((img) => img.isMain === true);
  assert.equal(mains.length, 1, `debe haber exactamente 1 imagen MAIN, hubo ${mains.length}`);
  const mainTyped = fresh.images.filter((img) => img.type === "MAIN");
  assert.equal(mainTyped.length, 1);
});

test("F4 concurrency: uploads simultaneos respetan el limite maximo (10) sin excederlo", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const N = 15; // mas que el limite, todos disparados a la vez
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) }),
    ),
  );

  const succeeded = responses.filter((r) => r.status === 200);
  const rejected = responses.filter((r) => r.status === 400);
  assert.equal(succeeded.length, 10, `deben aceptarse exactamente 10, se aceptaron ${succeeded.length}`);
  assert.equal(rejected.length, N - 10);

  const fresh = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(fresh.images.length, 10, "el producto nunca debe superar el limite, ni bajo carrera");
});

// ===========================================================================
// SECURITY
// ===========================================================================

test("F4 security: la respuesta de upload nunca contiene credenciales/config de Cloudinary", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  const text = await res.text();
  assert.doesNotMatch(text, /api_secret/i);
  assert.doesNotMatch(text, /apiSecret/i);
  assert.doesNotMatch(text, /CLOUDINARY_API_SECRET/);
});

test("F4 security: el catalogo publico nunca expone publicId", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA, admin } = ctx.users;
  const product = await createDraft(editorA.token, {
    details: "d",
    shippingInfo: "s",
    returnsInfo: "r",
  });
  await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) });
  await setStatus(product._id, editorA.token, { toStatus: "PENDING_REVIEW" });
  await setStatus(product._id, admin.token, { toStatus: "APPROVED" });
  await setStatus(product._id, admin.token, { toStatus: "PUBLISHED" });

  const res = await apiJson(`/api/product/${product._id}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.data.images.length > 0);
  for (const img of json.data.images) {
    assert.equal(Object.prototype.hasOwnProperty.call(img, "publicId"), false);
  }
});

test("F4 security: no se puede borrar una imagen de OTRO producto (imageId ajeno -> 404, no cross-product deletion)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA } = ctx.users;
  const productA = await createDraft(editorA.token);
  const productB = await createDraft(editorA.token);

  const uploaded = await (await uploadImage(productA._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const imageIdOfA = uploaded.data.images[0]._id;

  // Se intenta borrar la imagen de A pasando el :id de B en la URL.
  const res = await deleteImage(productB._id, imageIdOfA, editorA.token);
  assert.equal(res.status, 404);
  assert.equal(destroyCalls.length, 0, "no debe haberse llamado a Cloudinary destroy");

  // La imagen de A sigue intacta.
  const stillThere = await ctx.models.ProductModel.findById(productA._id).lean();
  assert.equal(stillThere.images.length, 1);
});

test("F4 security: un editor no puede borrar imagenes del producto de OTRO editor", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  stubCloudinaryDestroy(t);
  const { editorA, editorB } = ctx.users;
  const product = await createDraft(editorA.token);
  const uploaded = await (await uploadImage(product._id, { token: editorA.token, buffer: jpegBuffer(300, 300) })).json();
  const imageId = uploaded.data.images[0]._id;

  const res = await deleteImage(product._id, imageId, editorB.token);
  assert.equal(res.status, 403);

  const stillThere = await ctx.models.ProductModel.findById(product._id).lean();
  assert.equal(stillThere.images.length, 1);
});

test("F4 security: publicId enviado por el cliente en un PATCH normal se ignora (no se puede inventar/copiar uno ajeno)", async (t) => {
  if (guard(t)) return;
  stubCloudinaryUploadSuccess(t);
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const patchRes = await apiJson(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: {
      images: [
        {
          url: "http://dusck.test/pasted-manually.png",
          isMain: true,
          publicId: "otro-producto/asset-ajeno", // intento de inyectar un publicId ajeno
        },
      ],
    },
  });
  assert.equal(patchRes.status, 200);

  const raw = await ctx.models.ProductModel.findById(product._id).lean();
  assert.notEqual(raw.images[0].publicId, "otro-producto/asset-ajeno");
  assert.equal(raw.images[0].publicId, "");
});

test("F4 security: DELETE de imagen inexistente responde 404 (no crea ni borra nada)", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);
  const fakeImageId = new ctx.mongoose.Types.ObjectId().toString();

  const res = await deleteImage(product._id, fakeImageId, editorA.token);
  assert.equal(res.status, 404);
});

// ===========================================================================
// REGRESIÓN puntual (el resto de la suite completa se corre aparte)
// ===========================================================================

test("F4 regresion: PATCH /product/:id sin tocar `images` sigue funcionando igual que antes", async (t) => {
  if (guard(t)) return;
  const { editorA } = ctx.users;
  const product = await createDraft(editorA.token);

  const res = await apiJson(`/api/product/${product._id}`, {
    method: "PATCH",
    token: editorA.token,
    body: { name: "Producto F4 renombrado" },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.name, "Producto F4 renombrado");
});
