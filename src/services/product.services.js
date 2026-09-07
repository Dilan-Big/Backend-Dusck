import ProductModel from "../models/product.model.js";
import CategoryModel from "../models/category.model.js";
import { PRODUCT_STATUS } from "../helpers/productWorkflow.helper.js";
import { cloudinaryImageService } from "./cloudinaryImage.service.js";
import { MAX_IMAGES_PER_PRODUCT } from "../helpers/imageUpload.helper.js";

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

// FASE 5 — Normaliza color/talla SOLO para COMPARACIÓN (nunca se guarda el
// valor normalizado: el schema conserva lo que escribió el editor, `trim`
// incluido vía Mongoose). trim + minúsculas: "Blanco"/"blanco"/"BLANCO " son
// la MISMA variante lógica. Talla ausente ("") es un valor comparable válido
// en sí mismo — un producto sin variantes de talla (accesorios) puede tener
// como mucho UNA variante por color sin talla; una segunda "Blanco, sin
// talla" sigue siendo un duplicado real.
// F5-CLOSURE — esta función corre ANTES de la validación de Mongoose (se
// invoca sobre el array crudo del body, antes de `ProductModel.create` /
// `findOneAndUpdate`), así que sigue viendo tallas vacías tal cual el cliente
// las mandó. Eso es intencional: dos variantes NUEVAS con talla vacía y mismo
// color siguen detectándose como duplicado AQUÍ (409, mensaje "color y
// talla") antes de llegar al validador de schema que las rechazaría igual por
// talla obligatoria (400) — no cambia qué se persiste, solo cuál de los dos
// errores gana cuando ambos aplicarían. Productos sin tallaje deben usar
// "Única" (ver VariantSchema.size en product.model.js), no talla vacía.
const normalizeVariantAttr = (value) => String(value ?? "").trim().toLowerCase();

// La combinación lógica de una variante es COLOR + TALLA (independiente del
// SKU: dos variantes con el MISMO color+talla son la misma variante aunque
// el editor les haya puesto SKUs distintos por error). Detecta duplicados
// SOLO dentro del array que se está guardando — es intencional que NO se
// compare contra otros productos: dos productos distintos pueden ambos tener
// perfectamente una variante "Blanco/M" (ver F5 report — a diferencia del
// SKU, que sí es único globalmente, la combinación color+talla es un
// invariante LOCAL al documento, así que no hace falta ni es correcto un
// índice de Mongo para esto — un único `findOneAndUpdate`/`save` sobre UN
// documento ya es atómico por sí mismo, no hay ventana de carrera que cubrir
// con una segunda línea de defensa a nivel de base de datos).
const assertNoDuplicateVariantCombos = (variants = []) => {
  const seen = new Map();
  variants.forEach((v, i) => {
    const key = `${normalizeVariantAttr(v?.color)}::${normalizeVariantAttr(v?.size)}`;
    if (seen.has(key)) {
      const err = new Error(
        `Las variantes #${seen.get(key) + 1} y #${i + 1} tienen el mismo color y talla`,
      );
      err.code = "DUPLICATE_VARIANT_COMBO";
      throw err;
    }
    seen.set(key, i);
  });
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

// FASE 1 — `modelInfo`, SI viene en el payload, debe ser un objeto plano
// ({ size?, heightCm? }). Una cadena / array / número llegaría al `$set` de
// una ruta anidada y produciría un CastError opaco o un 500. `heightCm` en sí
// (rango, entero) lo valida el schema. `undefined` = "no tocar".
const assertModelInfoShape = (modelInfo) => {
  if (modelInfo === undefined || modelInfo === null) return;
  if (typeof modelInfo !== "object" || Array.isArray(modelInfo)) {
    const err = new Error("El campo 'modelInfo' debe ser un objeto con 'size' y/o 'heightCm'");
    err.code = "INVALID_MODEL_INFO";
    throw err;
  }
};

// FASE 1 — `images`, SI viene en el payload, debe ser un array. Mismo criterio
// que variants/categories: `undefined` = "no tocar"; cualquier no-array = 400.
const assertImagesArray = (images) => {
  if (images === undefined) return;
  if (!Array.isArray(images)) {
    const err = new Error("El campo 'images' debe ser una lista de imágenes");
    err.code = "INVALID_IMAGES";
    throw err;
  }
};

const dbCreateProduct = async (product) => {
  assertVariantsArray(product.variants);
  assertCategoriesArray(product.categories);
  assertModelInfoShape(product.modelInfo);
  assertImagesArray(product.images);
  if (product.categories?.length) await assertCategoriesExist(product.categories);
  if (product.variants?.length) {
    await assertNoDuplicateSkus(product.variants, null);
    assertNoDuplicateVariantCombos(product.variants);
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

// F6 — Admin Review. Resuelve `createdBy` y `workflowHistory[].by` (ObjectId
// -> `{ _id, name, nickname }`) para la respuesta EDITORIAL (cola de revisión
// + detalle). `product.model.js`/`admin.models.ts` ya dejaban comentado desde
// F1/F3 que esta resolución de nombre quedaba pendiente para F6.
//
// CRÍTICO — se llama SIEMPRE *después* de cualquier chequeo de ownership
// (`isOwner()` en el controller compara `String(product.createdBy)` contra el
// `_id` del usuario autenticado: necesita el ObjectId crudo, NO un objeto
// poblado). Popular antes de esa comparación la rompería (`String({...})` no
// es un ObjectId). Por eso este helper es un paso EXPLÍCITO y posterior, no
// parte de `dbGetProduct`/`dbGetProductById` — que se mantienen intactas para
// que cualquier otro caller (incluida la comparación de ownership) siga
// recibiendo el ObjectId sin transformar.
//
// Acepta un documento o un array de documentos (mismo `Model.populate()`
// estático de Mongoose para ambos casos). No toca las consultas PÚBLICAS
// (`dbGetPublicProducts`/`dbGetPublicProductById`): esas ni siquiera
// seleccionan `createdBy`/`workflowHistory` (ver `PUBLIC_PRODUCT_FIELDS`).
const REVIEW_ACTOR_POPULATE = [
  { path: "createdBy", select: "name nickname" },
  { path: "workflowHistory.by", select: "name nickname" },
];
const populateReviewActors = async (docOrDocs) => {
  if (!docOrDocs) return docOrDocs;
  return ProductModel.populate(docOrDocs, REVIEW_ACTOR_POPULATE);
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
//
// F7-A — ampliación del contrato público (F1/F4/F5 habían añadido campos al
// modelo que nunca llegaron a esta proyección):
//   · `details`/`shippingInfo`/`returnsInfo`/`modelInfo` (FASE 1) — ficha
//     comercial completa, antes invisible para el storefront.
//   · `publishedAt` — única fecha pública con sentido de "recién llegado"
//     (NUNCA `createdAt`/`updatedAt`, que pueden preceder o postdatar la
//     publicación real — un DRAFT editado meses después de creado no es
//     "reciente" solo por eso).
//   · `variants.color variants.size variants.stock` — proyección de
//     SUBCAMPOS (dot-path), NO el subdocumento completo: deja `sku` fuera a
//     propósito (dato interno de inventario, sin uso legítimo en el
//     storefront) sin tocar la estructura interna de `VariantSchema` ni su
//     validación/escritura (F5), que siguen intactas. Mongo permite mezclar
//     inclusión de campo completo ("images") con inclusión de subcampo por
//     punto ("variants.color") en la misma proyección; lo que NO se puede
//     mezclar es inclusión y exclusión del MISMO path, y aquí todo es
//     inclusión.
const PUBLIC_PRODUCT_FIELDS =
  "name slug description details shippingInfo returnsInfo modelInfo price images categories stock isActive publishedAt variants.color variants.size variants.stock";

// F7-A — nombre/slug de categoría en vez de solo el ObjectId crudo: evita que
// CADA consumidor público tenga que cruzar manualmente contra `GET /category`
// (como ya hacía `basicos.ts`) solo para mostrar un nombre. Selección mínima
// (`name slug`, nunca `isActive`/timestamps/etc.) — igual de estricta que
// `PUBLIC_PRODUCT_FIELDS` para Product. No filtra por categoría activa: una
// referencia a una categoría desactivada después de asignarse es una cuestión
// de curación editorial, no de seguridad (Category no tiene campos internos
// que proteger — ver `dbGetPublicCategories`).
const PUBLIC_CATEGORY_POPULATE = { path: "categories", select: "name slug" };

// FASE 4 — `publicId` es un detalle de implementación interno (identificador
// de Cloudinary usado únicamente por el backend para poder borrar/gestionar
// el asset). No es un secreto, pero tampoco tiene ningún uso legítimo en el
// storefront/público — se retira explícitamente aquí en vez de depender de
// una proyección Mongo mixta (inclusión de nivel superior + exclusión de
// subcampo), que es ambigua/frágil.
const stripInternalImageFields = (product) => {
  if (!product) return product;
  if (Array.isArray(product.images)) {
    product.images = product.images.map(({ publicId, ...rest }) => rest);
  }
  return product;
};

const dbGetPublicProducts = async () => {
  const products = await ProductModel.find(PUBLIC_FILTER)
    .select(PUBLIC_PRODUCT_FIELDS)
    .populate(PUBLIC_CATEGORY_POPULATE)
    .lean();
  return products.map(stripInternalImageFields);
};

const dbGetPublicProductById = async (id) => {
  const product = await ProductModel.findOne({ _id: id, ...PUBLIC_FILTER })
    .select(PUBLIC_PRODUCT_FIELDS)
    .populate(PUBLIC_CATEGORY_POPULATE)
    .lean();
  return stripInternalImageFields(product);
};

// FASE 4 — Reconcilia `images[].publicId` de un update ENTRANTE contra lo YA
// PERSISTIDO, para que un PATCH normal de contenido nunca pueda:
//   (a) inventar/copiar un `publicId` arbitrario (el cliente podría intentar
//       asociar el asset de Cloudinary de OTRO producto a este, o un
//       `publicId` inexistente) — se DESCARTA siempre el que venga del body;
//   (b) perder el `publicId` de una imagen subida por F4 en un guardado
//       posterior que no la toca — se REASIGNA por coincidencia exacta de
//       `url` contra las imágenes YA persistidas de ESTE MISMO producto
//       (nunca contra otros documentos: `current` se lee por `id`).
// Devuelve `{ images, removedPublicIds }`: `removedPublicIds` son los assets
// que YA NO aparecen en el array final (imagen quitada del producto por el
// propio usuario) — candidatos a cleanup best-effort en Cloudinary.
const reconcileImagePublicIds = (incomingImages, currentImages = []) => {
  const byUrl = new Map();
  const currentPublicIds = new Set();
  for (const img of currentImages) {
    if (img?.publicId) {
      currentPublicIds.add(img.publicId);
      if (img.url && !byUrl.has(img.url)) byUrl.set(img.url, img.publicId);
    }
  }

  const keptPublicIds = new Set();
  const images = incomingImages.map((img) => {
    if (!img || typeof img !== "object") return img;
    const { publicId: _clientPublicId, ...rest } = img;
    const matched = rest.url ? byUrl.get(rest.url) : undefined;
    if (matched) {
      keptPublicIds.add(matched);
      return { ...rest, publicId: matched };
    }
    return rest;
  });

  const removedPublicIds = [...currentPublicIds].filter((pid) => !keptPublicIds.has(pid));
  return { images, removedPublicIds };
};

// `productUpdate` YA viene filtrado por lista blanca DINÁMICA desde el
// controller (`editableFieldsFor`, según rol + estado + ownership). Se
// envuelve SIEMPRE en $set y se activan los validadores del schema.
const dbUpdateProductById = async (id, productUpdate) => {
  // PD2-004 / PD3-001 — forma de `variants` y `categories` ANTES de cualquier
  // operación que asuma array (`.map()` en los `assert*Exist` / hooks).
  assertVariantsArray(productUpdate.variants);
  assertCategoriesArray(productUpdate.categories);
  // FASE 1 — forma de `modelInfo` / `images` antes de tocar Mongoose.
  assertModelInfoShape(productUpdate.modelInfo);
  assertImagesArray(productUpdate.images);

  if (productUpdate.categories) await assertCategoriesExist(productUpdate.categories);
  if (productUpdate.variants) {
    await assertNoDuplicateSkus(productUpdate.variants, id);
    assertNoDuplicateVariantCombos(productUpdate.variants);
  }

  // FASE 4 — reconciliar publicId ANTES de escribir (ver `reconcileImagePublicIds`).
  let pendingCleanupPublicIds = [];
  if (Array.isArray(productUpdate.images)) {
    const currentForImages = await ProductModel.findById(id).select("images").lean();
    const { images, removedPublicIds } = reconcileImagePublicIds(
      productUpdate.images,
      currentForImages?.images ?? [],
    );
    productUpdate.images = images;
    pendingCleanupPublicIds = removedPublicIds;
  }

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

  const saved = await ProductModel.findOneAndUpdate(
    { _id: id }, // Objeto de consulta
    { $set: update }, // Datos a actualizar (solo $set)
    { new: true, runValidators: true }, // Documento actualizado + validacion
  );

  // FASE 4 — cleanup de huérfanos SOLO tras un guardado confirmado (si la
  // validación falló arriba, nada cambió en Mongo y no hay huérfano nuevo que
  // limpiar). Best-effort: `cloudinaryImageService.destroy` nunca lanza; un
  // fallo aquí NO afecta la respuesta 200 de la actualización del producto
  // (el contenido del producto ya se guardó correctamente) — queda como deuda
  // residual documentada (ver reporte F4, sin cola de reintentos).
  if (saved && pendingCleanupPublicIds.length > 0) {
    await Promise.allSettled(pendingCleanupPublicIds.map((pid) => cloudinaryImageService.destroy(pid)));
  }

  return saved;
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
const dbUpdateProductStatus = async (
  id,
  fromStatus,
  statusUpdate,
  unsetFields = [],
  historyEntry = null,
) => {
  const update = { $set: statusUpdate };
  if (unsetFields.length > 0) {
    update.$unset = Object.fromEntries(unsetFields.map((field) => [field, ""]));
  }
  // FASE 1 — la entrada de workflowHistory se añade en la MISMA escritura
  // atómica del cambio de estado (misma condición `status: fromStatus`), así
  // que la bitácora hereda la atomicidad: o se registra la transición completa
  // (status + metadata + historial) o no se registra nada (409 en el controller).
  if (historyEntry) {
    update.$push = { workflowHistory: historyEntry };
  }
  return await ProductModel.findOneAndUpdate(
    { _id: id, status: fromStatus },
    update,
    { new: true, runValidators: true },
  );
};

// FASE 4-CLOSURE — Añade UNA imagen ya subida a Cloudinary, de forma
// ATÓMICA frente a uploads CONCURRENTES al mismo producto (hallazgo de la
// auditoría externa: la versión F4 original decidía `isMain`/`order` a
// partir de una LECTURA previa de `product.images.length`, así que dos
// uploads simultáneos al mismo producto vacío podían leer ambos "0 imágenes"
// y terminar los dos con `isMain:true` — invariante rota).
//
// Estrategia (sin transacciones multi-documento — este proyecto usa MongoDB
// standalone, ver [[dusck-f4-checkout-phase]]): DOS intentos, cada uno con su
// propio filtro atómico evaluado por Mongo en el MISMO instante de la
// escritura (nunca contra una lectura previa):
//
//   Intento 1 — "reclamar ser la primera imagen": el filtro exige
//   `images` vacío/inexistente EN ESE INSTANTE. Si dos requests concurrentes
//   lo intentan, MongoDB serializa las escrituras sobre el documento: la
//   primera en aplicarse deja `images` con 1 elemento, así que la segunda YA
//   NO cumple el filtro y `findOneAndUpdate` devuelve `null` — como MUCHO una
//   request puede ganar este intento, así que como MUCHO una imagen puede
//   nacer `isMain:true` por esta vía. Esto es lo que cierra la carrera de
//   integridad de MAIN.
//
//   Intento 2 — no es la primera: se exige ADEMÁS, en el MISMO filtro
//   atómico (`$expr` sobre `$size` del array evaluado en el instante de la
//   escritura, no en una lectura previa), que el producto siga por debajo
//   del límite máximo — cierra el mismo tipo de carrera para "cuántas
//   imágenes tiene el producto" (ver F4-CLOSURE §3, uploads concurrentes).
//   `order` SÍ se calcula a partir de una lectura fresca justo antes de
//   escribir: una colisión de `order` entre dos "no-primeras" concurrentes
//   es cosméticamente posible (metadata editable, nunca decide la principal
//   — `normalizeProductImages` no la usa) y ya es un escenario que la
//   propia FASE 4 pide tolerar ("órdenes duplicados"), a diferencia de
//   `isMain`, que sí queda protegido por el filtro atómico.
//
// Devuelve `{ product, limitReached }`:
//   - `{ product: doc, limitReached: false }`   éxito.
//   - `{ product: null, limitReached: true }`   el producto ya estaba en el
//     límite (o lo alcanzó por una carrera) — el caller revierte el asset de
//     Cloudinary recién subido (huérfano evitado, ver product.controllers.js).
//   - `{ product: null, limitReached: false }`  el producto ya no existe
//     (borrado concurrentemente) — mismo tratamiento de huérfano.
const dbAddProductImage = async (id, { url, publicId, alt = "" }) => {
  const base = { url, publicId, alt };

  const claimedFirst = await ProductModel.findOneAndUpdate(
    { _id: id, $or: [{ images: { $exists: false } }, { images: { $size: 0 } }] },
    { $push: { images: { ...base, isMain: true, type: "MAIN", order: 0 } } },
    { new: true, runValidators: true },
  );
  if (claimedFirst) return { product: claimedFirst, limitReached: false };

  const fresh = await ProductModel.findById(id).select("images");
  if (!fresh) return { product: null, limitReached: false };
  if (fresh.images.length >= MAX_IMAGES_PER_PRODUCT) {
    return { product: null, limitReached: true };
  }

  const updated = await ProductModel.findOneAndUpdate(
    {
      _id: id,
      $expr: { $lt: [{ $size: { $ifNull: ["$images", []] } }, MAX_IMAGES_PER_PRODUCT] },
    },
    { $push: { images: { ...base, isMain: false, type: "DETAIL", order: fresh.images.length } } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    // Perdió la carrera del límite en el último instante frente a otra
    // request concurrente — no es huérfano en Mongo (nunca se escribió),
    // pero el asset de Cloudinary recién subido sí lo sería si el caller no
    // lo revierte (lo hace, ver `uploadProductImage`).
    return { product: null, limitReached: true };
  }
  return { product: updated, limitReached: false };
};

// FASE 4 — Quita UNA imagen por su `_id` de subdocumento (nunca por
// `publicId` del cliente — ver DELETE /product/:id/images/:imageId). Si la
// imagen removida era la principal y quedan otras, promueve la posición 0 a
// principal (mismo criterio determinista que `normalizeProductImages`: "si
// ninguna está marcada, la posición 0 se convierte en MAIN" — aquí se cumple
// porque tras quitar la ÚNICA principal existente, ninguna otra puede
// quedar marcada, por la invariante ya garantizada). Devuelve:
//   - `{ found: false }`               el producto no existe o la imagen no
//                                       pertenece a este producto (404 en el controller);
//   - `{ found: true, product, removedPublicId }`  éxito; `removedPublicId`
//     puede ser "" si la imagen era una URL legada (nunca subida a Cloudinary).
// El borrado en Cloudinary es SIEMPRE best-effort (`cloudinaryImageService.destroy`
// nunca lanza): la eliminación en Mongo ya se confirmó antes de intentarlo.
const dbRemoveProductImage = async (id, imageId) => {
  const current = await ProductModel.findById(id).select("images");
  if (!current) return { found: false };

  const target = current.images.id(imageId);
  if (!target) return { found: false };

  const wasMain = target.isMain === true;
  const removedPublicId = target.publicId || "";

  let product = await ProductModel.findOneAndUpdate(
    { _id: id },
    { $pull: { images: { _id: imageId } } },
    { new: true, runValidators: true },
  );

  if (product && wasMain && product.images.length > 0 && !product.images.some((img) => img.isMain)) {
    product = await ProductModel.findOneAndUpdate(
      { _id: id },
      { $set: { "images.0.isMain": true, "images.0.type": "MAIN" } },
      { new: true, runValidators: true },
    );
  }

  if (removedPublicId) {
    await cloudinaryImageService.destroy(removedPublicId);
  }

  return { found: true, product, removedPublicId };
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
  populateReviewActors,
  dbUpdateProductById,
  dbUpdateProductStatus,
  dbAddProductImage,
  dbRemoveProductImage,
  dbDeleteProductById,
  dbProductsUseCategory,
};
