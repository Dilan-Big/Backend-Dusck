import ProductModel from "../models/product.model.js";
import CategoryModel from "../models/category.model.js";
import { PRODUCT_STATUS } from "../helpers/productWorkflow.helper.js";

// --- Validaciones de dominio (además del índice único / refs de Mongoose) ---

// PD3-001 — `categories`, SI viene en el payload, tiene que ser un array. Un
// `"HOMBRE"`, `5` o `{}` llegaría a `assertCategoriesExist` -> `.map()` y
// reventaría en un 500 (TypeError). Se valida ANTES de assertCategoriesExist.
// `undefined` (campo ausente) es legítimo. `null` se trata como inválido — el
// contrato para "sin categorías" es `[]` explícito (mismo criterio que
// `assertVariantsArray` / PD2-004). Un array con ids inválidos NO se toca aquí:
// lo sigue capturando la validación de referencia existente (CastError -> 400).
const assertCategoriesArray = (categories) => {
  if (categories === undefined) return;
  if (!Array.isArray(categories)) {
    const err = new Error("El campo 'categories' debe ser una lista de identificadores");
    err.code = "INVALID_CATEGORIES";
    throw err;
  }
};

// Impide guardar categorías inexistentes. El índice de Mongo NO lo detecta
// (un ObjectId "válido" pero inexistente no dispara ningún error de escritura).
const assertCategoriesExist = async (categoryIds = []) => {
  const ids = [...new Set(categoryIds.map(String))];
  if (ids.length === 0) return;
  const count = await CategoryModel.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) {
    const err = new Error("Una o más categorías indicadas no existen");
    err.code = "INVALID_CATEGORY_REF";
    throw err;
  }
};

// PRIMERA línea de defensa contra SKU duplicado: valida ANTES de tocar Mongo,
// para poder devolver un 409 semántico y claro (qué SKU, por qué). El índice
// único parcial en `product.model.js` es la SEGUNDA línea (cubre condiciones
// de carrera entre dos requests concurrentes que pasen esta validación a la vez).
//
//   - duplicado DENTRO del mismo array de variantes que se está guardando;
//   - duplicado contra CUALQUIER OTRO producto de la colección.
const assertNoDuplicateSkus = async (variants = [], excludeProductId = null) => {
  const skus = variants.map((v) => (v?.sku ?? "").trim()).filter((sku) => sku.length > 0);
  if (skus.length === 0) return;

  const seen = new Set();
  for (const sku of skus) {
    if (seen.has(sku)) {
      const err = new Error(`El SKU "${sku}" está duplicado dentro del mismo producto`);
      err.code = "DUPLICATE_SKU_LOCAL";
      throw err;
    }
    seen.add(sku);
  }

  const query = { "variants.sku": { $in: skus } };
  if (excludeProductId) query._id = { $ne: excludeProductId };
  const clash = await ProductModel.findOne(query, { _id: 1 });
  if (clash) {
    const err = new Error("Uno de los SKU indicados ya está en uso por otro producto");
    err.code = "DUPLICATE_SKU_GLOBAL";
    throw err;
  }
};

// PD-003 — Recalcula `Product.stock` como agregado derivado de las variantes.
// Fuente única de verdad cuando hay variantes: `variants[].stock`.
const sumVariantStock = (variants = []) =>
  variants.reduce((sum, v) => sum + (Number(v?.stock) || 0), 0);

// PD2-004 — `variants`, SI viene en el payload, tiene que ser un array. Un
// `"x"`, `{}`, `123` o `null` llegaría a lógica que asume `.map()` / `.length`
// y reventaría en un 500 (TypeError) o en un ValidationError opaco. Se valida
// ANTES de assertNoDuplicateSkus / sumVariantStock / el hook del modelo.
// `undefined` (campo ausente) es legítimo: significa "no tocar las variantes".
// `null` se trata como inválido — el contrato para quitar todas las variantes
// es `variants: []` explícito (ver PD2-005).
const assertVariantsArray = (variants) => {
  if (variants === undefined) return;
  if (!Array.isArray(variants)) {
    const err = new Error("El campo 'variants' debe ser una lista de variantes");
    err.code = "INVALID_VARIANTS";
    throw err;
  }
};

const dbCreateProduct = async (product) => {
  assertVariantsArray(product.variants);
  assertCategoriesArray(product.categories);
  if (product.categories?.length) await assertCategoriesExist(product.categories);
  if (product.variants?.length) {
    await assertNoDuplicateSkus(product.variants, null);
    // PD-003 — Con variantes, `stock` es DERIVADO: nunca se acepta del cliente.
    // El hook `pre('save')` lo recalcula igual, pero se elimina aquí para que
    // la regla sea explícita en el punto de entrada del dominio.
    delete product.stock;
  }
  return await ProductModel.create(product);
};

// Todos los productos, sin filtrar por estado/activación. USO INTERNO
// (el controller decide a quién se le puede mostrar esto: administrador,
// shop_manager, o al editor filtrado por `createdBy`).
const dbGetProduct = async () => {
  return await ProductModel.find();
};

// Fetch "crudo": cualquier estado. Uso interno para revisar ownership/status
// antes de decidir qué puede ver o editar el usuario autenticado.
const dbGetProductById = async (id) => {
  return await ProductModel.findOne({
    _id: id,
  });
};

// --- Consultas PÚBLICAS: el backend es la barrera real (Regla §24) ---------
// Nunca basta con `isActive`; el Storefront solo puede ver PUBLISHED + activo.
const PUBLIC_FILTER = { status: PRODUCT_STATUS.PUBLISHED, isActive: true };

// PD-001 — Contrato PÚBLICO explícito de Product. El storefront (incluido el
// render SSR, donde la respuesta acaba en el HTML / TransferState) SOLO debe
// recibir estos campos. Toda la trazabilidad editorial —createdBy, updatedBy,
// submittedBy/At, approvedBy/At, rejectedBy/At, rejectionReason, publishedBy/At—
// y el propio `status` quedan FUERA: no basta con que Angular no los pinte.
// `_id` lo incluye Mongoose por defecto. El contrato ADMIN (dbGetProduct /
// dbGetProductById) NO cambia: los usuarios autorizados siguen recibiendo todo.
const PUBLIC_PRODUCT_FIELDS = "name slug description price images categories stock isActive";

const dbGetPublicProducts = async () => {
  return await ProductModel.find(PUBLIC_FILTER).select(PUBLIC_PRODUCT_FIELDS).lean();
};

const dbGetPublicProductById = async (id) => {
  return await ProductModel.findOne({ _id: id, ...PUBLIC_FILTER })
    .select(PUBLIC_PRODUCT_FIELDS)
    .lean();
};

// `productUpdate` YA viene filtrado por lista blanca DINÁMICA desde el
// controller (`editableFieldsFor`, según rol + estado + ownership). Se
// envuelve SIEMPRE en $set y se activan los validadores del schema.
const dbUpdateProductById = async (id, productUpdate) => {
  // PD2-004 / PD3-001 — forma de `variants` y `categories` ANTES de cualquier
  // operación que asuma array (`.map()` en los `assert*Exist` / hooks).
  assertVariantsArray(productUpdate.variants);
  assertCategoriesArray(productUpdate.categories);

  if (productUpdate.categories) await assertCategoriesExist(productUpdate.categories);
  if (productUpdate.variants) await assertNoDuplicateSkus(productUpdate.variants, id);

  // PD-003 — Integridad de `Product.stock` frente a las variantes.
  //   - Producto SIN variantes: `stock` plano es la fuente de verdad (se acepta).
  //   - Producto CON variantes: `stock` es un AGREGADO DERIVADO = Σ variants.stock.
  //     Se ignora cualquier `stock` del body para que un PATCH parcial como
  //     `{ "stock": 999 }` no pueda dejarlo desincronizado.
  const update = { ...productUpdate };
  if ("variants" in update) {
    // El update redefine las variantes: si trae alguna, el hook del modelo ya
    // recalcula `stock`; quitamos cualquier `stock` del body para que no compita.
    if (Array.isArray(update.variants) && update.variants.length > 0) {
      delete update.stock;
    } else {
      // `variants: []` — se está convirtiendo el producto a "simple".
      // PD2-005 — no se infiere un stock que el cliente no declaró: si el
      // producto TENÍA variantes y el mismo update no trae `stock`, se rechaza
      // (400). Si ya era simple, no hay conversión y no se exige nada nuevo.
      const current = await ProductModel.findById(id).select("variants").lean();
      const wasVariantized =
        current && Array.isArray(current.variants) && current.variants.length > 0;
      if (wasVariantized && !("stock" in update)) {
        const err = new Error(
          "Al quitar todas las variantes debes indicar el `stock` del producto simple resultante",
        );
        err.code = "STOCK_REQUIRED";
        throw err;
      }
      // Con `stock` presente (o producto que ya era simple): `stock` plano se respeta.
    }
  } else {
    // El update NO toca variantes: hay que mirar el documento persistido.
    const current = await ProductModel.findById(id).select("variants").lean();
    if (current && Array.isArray(current.variants) && current.variants.length > 0) {
      delete update.stock;
      update.stock = sumVariantStock(current.variants);
    }
  }

  return await ProductModel.findOneAndUpdate(
    { _id: id }, // Objeto de consulta
    { $set: update }, // Datos a actualizar (solo $set)
    { new: true, runValidators: true }, // Documento actualizado + validacion
  );
};

// Transición de estado: separada de `dbUpdateProductById` a propósito. Los
// campos de workflow (status, *_By, *_At, rejectionReason) NUNCA pasan por la
// lista blanca de contenido — los construye únicamente el controller de
// transición, ya validado contra `canTransitionProduct`.
//
// PD-004 — La transición es ATÓMICA: el filtro incluye `status: fromStatus`,
// así que `findOneAndUpdate` solo aplica si el documento SIGUE en el estado
// que el controller validó. Si dos transiciones concurrentes parten del mismo
// estado (p. ej. aprobar vs. rechazar un PENDING_REVIEW), MongoDB serializa
// los dos updates: el primero cambia el `status` y el segundo ya no encuentra
// coincidencia -> devuelve `null` -> el controller responde 409. Nunca queda
// un documento con metadata mixta (approvedAt + rejectedAt).
//
// PD2-001 — `unsetFields` son campos de metadata de workflow que ya no
// pertenecen al estado destino y se eliminan en la MISMA escritura atómica
// (mismo `findOneAndUpdate`, misma condición `status: fromStatus`), así que la
// limpieza hereda la atomicidad y no abre una ventana de estado incoherente.
const dbUpdateProductStatus = async (id, fromStatus, statusUpdate, unsetFields = []) => {
  const update = { $set: statusUpdate };
  if (unsetFields.length > 0) {
    update.$unset = Object.fromEntries(unsetFields.map((field) => [field, ""]));
  }
  return await ProductModel.findOneAndUpdate(
    { _id: id, status: fromStatus },
    update,
    { new: true, runValidators: true },
  );
};

const dbDeleteProductById = async (id) => {
  return await ProductModel.findOneAndDelete({
    _id: id,
  });
};

// Usado por la eliminación de categorías: impide dejar productos con una
// referencia rota (Regla §14 — no eliminar categorías en uso sin definir
// comportamiento seguro).
const dbProductsUseCategory = async (categoryId) => {
  return await ProductModel.exists({ categories: categoryId });
};

export {
  dbCreateProduct,
  dbGetProduct,
  dbGetProductById,
  dbGetPublicProducts,
  dbGetPublicProductById,
  dbUpdateProductById,
  dbUpdateProductStatus,
  dbDeleteProductById,
  dbProductsUseCategory,
};
