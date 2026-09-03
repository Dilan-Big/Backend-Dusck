// FASE 4.3-B — Tests del Order Creation Service.
//
// Base de datos APARTE: `db-dusck-order-service-test`, que se elimina al empezar
// y al terminar (misma estrategia que el resto de la suite). Si no hay MongoDB
// disponible, la suite entera se marca `skip`.
//
// Alcance: SOLO `createOrder(...)`. No hay rutas, controllers, workflow,
// Google Sheets ni rate limiting.
//
// Ejecutar:  node --test tests/order-service.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import OrderModel from "../src/models/order.model.js";
import CounterModel from "../src/models/counter.model.js";
import ProductModel from "../src/models/product.model.js";
import { createOrder, ORDER_ERROR_CODES } from "../src/services/order.service.js";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-service-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([OrderModel.init(), CounterModel.init(), ProductModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[order-service] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (mongoAvailable) {
    await Promise.all([
      OrderModel.deleteMany({}),
      CounterModel.deleteMany({}),
      ProductModel.deleteMany({}),
    ]);
  }
});

test.after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// --- fixtures ----------------------------------------------------------

const makeProduct = (over = {}) =>
  ProductModel.create({
    name: over.name ?? "Camiseta Essential",
    slug: over.slug ?? `camiseta-${randomUUID().slice(0, 8)}`,
    description: over.description ?? "Algodón peinado",
    price: over.price ?? 85000,
    images: over.images ?? [
      { url: "http://dusck.test/sec.png", isMain: false },
      { url: "http://dusck.test/main.png", isMain: true },
    ],
    variants: over.variants ?? [],
    stock: over.stock ?? 10,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: new mongoose.Types.ObjectId(),
  });

const baseInput = (over = {}) => ({
  items: over.items ?? [{ productId: over.productId, quantity: over.quantity ?? 2 }],
  customer: over.customer ?? { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" },
  shippingAddress:
    over.shippingAddress ?? {
      department: "Antioquia",
      city: "Medellín",
      neighborhood: "Laureles",
      address: "Calle 12 # 34-56 apto 201",
    },
  notes: over.notes,
  userId: "userId" in over ? over.userId : null,
  source: over.source ?? "web",
  idempotencyKey: "idempotencyKey" in over ? over.idempotencyKey : randomUUID(),
});

const rejectsWithCode = async (fn, code) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `esperaba ${code}, obtuvo ${err.code} (${err.message})`);
    return true;
  });
};

// ====================================================================
// Validación de entrada
// ====================================================================

test("input: items ausente / vacío -> 400", async (t) => {
  if (skipIfNoMongo(t)) return;
  await rejectsWithCode(() => createOrder(baseInput({ items: undefined })), ORDER_ERROR_CODES.INVALID_INPUT);
  await rejectsWithCode(() => createOrder(baseInput({ items: [] })), ORDER_ERROR_CODES.INVALID_INPUT);
});

test("input: productId inválido -> 400", async (t) => {
  if (skipIfNoMongo(t)) return;
  await rejectsWithCode(
    () => createOrder(baseInput({ items: [{ productId: "no-es-id", quantity: 1 }] })),
    ORDER_ERROR_CODES.INVALID_INPUT,
  );
  await rejectsWithCode(
    () => createOrder(baseInput({ items: [{ productId: { $ne: null }, quantity: 1 }] })),
    ORDER_ERROR_CODES.INVALID_INPUT,
  );
});

test("input: quantity decimal / string / objeto -> 400", async (t) => {
  if (skipIfNoMongo(t)) return;
  const pid = new mongoose.Types.ObjectId().toString();
  for (const quantity of [1.5, "2", { $gt: 0 }, NaN]) {
    await rejectsWithCode(
      () => createOrder(baseInput({ items: [{ productId: pid, quantity }] })),
      ORDER_ERROR_CODES.INVALID_INPUT,
    );
  }
});

test("input: quantity 0 / negativa -> 422", async (t) => {
  if (skipIfNoMongo(t)) return;
  const pid = new mongoose.Types.ObjectId().toString();
  await rejectsWithCode(
    () => createOrder(baseInput({ items: [{ productId: pid, quantity: 0 }] })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  await rejectsWithCode(
    () => createOrder(baseInput({ items: [{ productId: pid, quantity: -3 }] })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
});

test("input: quantity > 50 en una sola línea -> 422", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 100 });
  await rejectsWithCode(
    () => createOrder(baseInput({ items: [{ productId: p._id.toString(), quantity: 51 }] })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  const fresh = await ProductModel.findById(p._id);
  assert.equal(fresh.stock, 100, "el stock no debe tocarse ante entrada inválida");
});

test("input: customer incompleto -> 400; customer con teléfono inválido -> 422", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct();
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), customer: { recipientName: "Ana" } })),
    ORDER_ERROR_CODES.INVALID_INPUT,
  );
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({
          productId: p._id.toString(),
          customer: { recipientName: "Ana", phone: "123", email: "a@b.co" },
        }),
      ),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
});

test("input: shippingAddress incompleta -> 400", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct();
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({ productId: p._id.toString(), shippingAddress: { department: "Antioquia", city: "Medellín" } }),
      ),
    ORDER_ERROR_CODES.INVALID_INPUT,
  );
});

test("input: Idempotency-Key ausente / vacía / no-UUID -> 400", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct();
  for (const idempotencyKey of [undefined, "", "no-es-uuid", "1234"]) {
    await rejectsWithCode(
      () => createOrder(baseInput({ productId: p._id.toString(), idempotencyKey })),
      ORDER_ERROR_CODES.INVALID_INPUT,
    );
  }
});

test("input: source distinto de 'web' -> 400 (admin no lo maneja este servicio)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct();
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), source: "admin" })),
    ORDER_ERROR_CODES.INVALID_INPUT,
  );
});

// ====================================================================
// Producto
// ====================================================================

test("producto: inexistente -> 404", async (t) => {
  if (skipIfNoMongo(t)) return;
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: new mongoose.Types.ObjectId().toString(), quantity: 1 })),
    ORDER_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
  );
});

test("producto: no PUBLISHED / inactivo -> 404", async (t) => {
  if (skipIfNoMongo(t)) return;
  const draft = await makeProduct({ status: "DRAFT", isActive: false });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: draft._id.toString(), quantity: 1 })),
    ORDER_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
  );
  const inactive = await makeProduct({ status: "PUBLISHED", isActive: false });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: inactive._id.toString(), quantity: 1 })),
    ORDER_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
  );
});

test("producto: con variantes -> 422 y sin tocar stock", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({
    variants: [{ sku: "CAM-NEG-M", color: "Negro", size: "M", stock: 7 }],
  });
  const stockBefore = (await ProductModel.findById(p._id)).stock;
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1 })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  assert.equal((await ProductModel.findById(p._id)).stock, stockBefore);
});

test("producto: stock insuficiente -> 409 y stock intacto", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 1 });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 2 })),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
  assert.equal((await ProductModel.findById(p._id)).stock, 1);
  assert.equal(await OrderModel.countDocuments({}), 0, "no debe quedar ni skeleton");
});

// ====================================================================
// Happy path + snapshot + dinero
// ====================================================================

test("guest: crea la orden finalizada con todos los campos del contrato", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ price: 85000, stock: 10, name: "Camiseta Essential" });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 3, userId: null }));

  assert.equal(order.finalized, true);
  assert.equal(order.userId, null);
  assert.equal(order.source, "web");
  assert.match(order.orderNumber, /^DUSCK-\d{4}-\d{6}$/);
  assert.equal(order.status, "pending_confirmation");
  assert.equal(order.payment.method, "cash_on_delivery");
  assert.equal(order.payment.status, "pending");
  assert.equal(order.statusHistory.length, 1);
  assert.equal(order.statusHistory[0].status, "pending_confirmation");
  assert.equal(order.statusHistory[0].changedBy, null);

  assert.equal(order.items.length, 1);
  const it = order.items[0];
  assert.equal(it.productName, "Camiseta Essential");
  assert.equal(it.slug, p.slug);
  assert.equal(it.image, "http://dusck.test/main.png"); // la marcada isMain
  assert.equal(it.unitPrice, 85000);
  assert.equal(it.quantity, 3);
  assert.equal(it.subtotal, 255000);

  assert.equal(order.totals.itemsSubtotal, 255000);
  assert.equal(order.totals.shipping, 0);
  assert.equal(order.totals.grandTotal, 255000);
  assert.equal(order.totals.currency, "COP");

  assert.equal((await ProductModel.findById(p._id)).stock, 7);
});

test("authenticated: conserva userId y NO consulta el Cart", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct();
  const uid = new mongoose.Types.ObjectId();
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 1, userId: uid.toString() }));
  assert.equal(order.source, "web");
  assert.ok(order.userId.equals(uid));
  // El servicio no importa CartModel: no hay colección `carts` tras crear el pedido.
  const collections = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.ok(!collections.includes("carts"), "el servicio no debe crear ni tocar el Cart");
});

test("dinero: los importes son enteros y el total lo calcula el backend", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ price: 42990, stock: 10 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 4 }));
  for (const v of [
    order.items[0].unitPrice,
    order.items[0].subtotal,
    order.totals.itemsSubtotal,
    order.totals.shipping,
    order.totals.grandTotal,
  ]) {
    assert.ok(Number.isInteger(v), `${v} debería ser entero`);
  }
  assert.equal(order.items[0].subtotal, 42990 * 4);
  assert.equal(order.totals.grandTotal, order.totals.itemsSubtotal);
});

test("precio: el enviado por el cliente se IGNORA; se usa product_b.price", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ price: 85000, stock: 10 });
  const order = await createOrder(
    baseInput({
      productId: p._id.toString(),
      items: [{ productId: p._id.toString(), quantity: 2, unitPrice: 1, subtotal: 2, price: 1 }],
    }),
  );
  assert.equal(order.items[0].unitPrice, 85000);
  assert.equal(order.items[0].subtotal, 170000);
  assert.equal(order.totals.grandTotal, 170000);
});

test("precio: product.price con decimales se redondea (Math.round) al congelar", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ price: 99999.6, stock: 5 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 1 }));
  assert.equal(order.items[0].unitPrice, 100000);
});

test("snapshot: modificar el Product después NO cambia la Order", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ name: "Nombre Original", price: 50000, stock: 10 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 2 }));

  await ProductModel.findByIdAndUpdate(p._id, { name: "Nombre Cambiado", price: 999999 });
  const reloaded = await OrderModel.findById(order._id);
  assert.equal(reloaded.items[0].productName, "Nombre Original");
  assert.equal(reloaded.items[0].unitPrice, 50000);
  assert.equal(reloaded.items[0].subtotal, 100000);
  assert.equal(reloaded.totals.grandTotal, 100000);
});

// ====================================================================
// Duplicate productId
// ====================================================================

test("duplicados: A×2 + A×3 -> una sola línea A×5", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ price: 10000, stock: 20 });
  const id = p._id.toString();
  const order = await createOrder(
    baseInput({
      productId: id,
      items: [
        { productId: id, quantity: 2 },
        { productId: id, quantity: 3 },
      ],
    }),
  );
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 5);
  assert.equal(order.items[0].subtotal, 50000);
  assert.equal(order.requestedItems.length, 1);
  assert.equal(order.requestedItems[0].quantity, 5);
  assert.equal((await ProductModel.findById(p._id)).stock, 15);
});

test("duplicados: A×40 + A×11 = 51 -> 422 (no se puede evadir el límite)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 100 });
  const id = p._id.toString();
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({
          productId: id,
          items: [
            { productId: id, quantity: 40 },
            { productId: id, quantity: 11 },
          ],
        }),
      ),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  assert.equal((await ProductModel.findById(p._id)).stock, 100);
});

// ====================================================================
// Stock atómico + concurrencia
// ====================================================================

test("stock: se decrementa exactamente la cantidad pedida", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  await createOrder(baseInput({ productId: p._id.toString(), quantity: 3 }));
  assert.equal((await ProductModel.findById(p._id)).stock, 7);
});

test("concurrencia stock=1: dos requests -> una orden, una en conflicto, stock nunca negativo", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 1 });
  const id = p._id.toString();
  const results = await Promise.allSettled([
    createOrder(baseInput({ productId: id, quantity: 1 })),
    createOrder(baseInput({ productId: id, quantity: 1 })),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, ORDER_ERROR_CODES.STOCK_CONFLICT);
  assert.equal((await ProductModel.findById(p._id)).stock, 0);
  assert.equal(await OrderModel.countDocuments({ finalized: true }), 1);
  assert.equal(await OrderModel.countDocuments({ finalized: false }), 0);
});

// ====================================================================
// Idempotencia
// ====================================================================

test("idempotencia: retry con la misma key tras finalizar -> misma orden, sin re-decrementar stock", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const input = baseInput({ productId: p._id.toString(), quantity: 2 });

  const first = await createOrder(input);
  const second = await createOrder(input);

  assert.equal(String(first._id), String(second._id));
  assert.equal(first.orderNumber, second.orderNumber);
  assert.equal(await OrderModel.countDocuments({}), 1);
  assert.equal((await ProductModel.findById(p._id)).stock, 8); // decrementado UNA vez
});

test("idempotencia: skeleton no finalizado con la misma key -> 409 retryable", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const key = randomUUID();
  // Simula una operación previa que quedó a medias (skeleton).
  await OrderModel.create({
    idempotencyKey: key,
    source: "web",
    userId: null,
    requestedItems: [{ productId: p._id, quantity: 1 }],
    customer: { recipientName: "Ana", phone: "3001234567", email: "a@b.co" },
    shippingAddress: { department: "Antioquia", city: "Medellín", neighborhood: "Laureles", address: "Cra 1 # 2-3" },
    finalized: false,
  });

  await assert.rejects(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, idempotencyKey: key })),
    (err) => {
      assert.equal(err.code, ORDER_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS);
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal((await ProductModel.findById(p._id)).stock, 10, "no se decrementa nada");
});

test("idempotencia: dos requests concurrentes con la misma key -> una sola orden", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const input = baseInput({ productId: p._id.toString(), quantity: 2 });

  const results = await Promise.allSettled([createOrder(input), createOrder(input)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  // O ambas devuelven la misma orden, o una crea y la otra recibe 409 retryable.
  assert.ok(fulfilled.length >= 1);
  if (rejected.length === 1) {
    assert.equal(rejected[0].reason.code, ORDER_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS);
  }
  if (fulfilled.length === 2) {
    assert.equal(String(fulfilled[0].value._id), String(fulfilled[1].value._id));
  }
  assert.equal(await OrderModel.countDocuments({ idempotencyKey: input.idempotencyKey }), 1);
  assert.equal((await ProductModel.findById(p._id)).stock, 8); // decrementado UNA vez
});

// ====================================================================
// Múltiples productos + compensación
// ====================================================================

test("multi-producto: crea una orden con varias líneas y decrementa cada stock", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await makeProduct({ price: 10000, stock: 5 });
  const b = await makeProduct({ price: 20000, stock: 5 });
  const order = await createOrder(
    baseInput({
      items: [
        { productId: a._id.toString(), quantity: 2 },
        { productId: b._id.toString(), quantity: 1 },
      ],
    }),
  );
  assert.equal(order.items.length, 2);
  assert.equal(order.totals.grandTotal, 2 * 10000 + 1 * 20000);
  assert.equal((await ProductModel.findById(a._id)).stock, 3);
  assert.equal((await ProductModel.findById(b._id)).stock, 4);
});

test("compensación: si una línea posterior no tiene stock, se restauran las anteriores", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await makeProduct({ stock: 5 });
  const b = await makeProduct({ stock: 5 });
  const c = await makeProduct({ stock: 0 }); // esta falla
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({
          items: [
            { productId: a._id.toString(), quantity: 1 },
            { productId: b._id.toString(), quantity: 1 },
            { productId: c._id.toString(), quantity: 1 },
          ],
        }),
      ),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
  assert.equal((await ProductModel.findById(a._id)).stock, 5, "A restaurado");
  assert.equal((await ProductModel.findById(b._id)).stock, 5, "B restaurado");
  assert.equal((await ProductModel.findById(c._id)).stock, 0);
  assert.equal(await OrderModel.countDocuments({}), 0, "skeleton eliminado tras compensación completa");
});

test("compensación fallida: el error NO se oculta y el skeleton queda finalized:false para el reaper", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await makeProduct({ stock: 5 });
  const b = await makeProduct({ stock: 0 }); // fuerza el fallo tras decrementar A

  // F4.3-B-R2.2 — la compensación es una update pipeline (array). Fuerza que
  // falle; el decremento (update con operadores `$inc`/`$push`) sigue funcionando.
  const realFOU = ProductModel.findOneAndUpdate.bind(ProductModel);
  t.mock.method(ProductModel, "findOneAndUpdate", function (filter, update, options) {
    if (Array.isArray(update)) {
      return Promise.reject(new Error("fallo simulado de compensación"));
    }
    return realFOU(filter, update, options);
  });

  const key = randomUUID();
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({
          idempotencyKey: key,
          items: [
            { productId: a._id.toString(), quantity: 1 },
            { productId: b._id.toString(), quantity: 1 },
          ],
        }),
      ),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );

  const skeleton = await OrderModel.findOne({ idempotencyKey: key });
  assert.ok(skeleton, "el skeleton debe seguir existiendo");
  assert.equal(skeleton.finalized, false);
  assert.equal((await ProductModel.findById(a._id)).stock, 4, "A quedó decrementado (compensación falló)");
});
