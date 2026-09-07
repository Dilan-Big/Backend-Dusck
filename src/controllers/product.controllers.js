import mongoose from "mongoose";

import {
  dbAddProductImage,
  dbCreateProduct,
  dbDeleteProductById,
  dbGetProduct,
  dbGetProductById,
  dbGetPublicProducts,
  dbGetPublicProductById,
  populateReviewActors,
  dbRemoveProductImage,
  dbUpdateProductById,
  dbUpdateProductStatus,
} from "../services/product.services.js";
import { cloudinaryImageService } from "../services/cloudinaryImage.service.js";
import { ROLES } from "../config/global.config.js";
import {
  PRODUCT_ALL_UPDATABLE_FIELDS,
  PRODUCT_CREATABLE_FIELDS,
  PRODUCT_STATUS,
  PRODUCT_STATUSES,
  canTransitionProduct,
  collectSubmitReviewErrors,
  editableFieldsFor,
  staleWorkflowMetadata,
  transitionErrorMessage,
  workflowActionFor,
} from "../helpers/productWorkflow.helper.js";
import { pickAllowed } from "../helpers/validation.helpers.js";
import { sendWriteError } from "../helpers/writeError.helper.js";
import {
  MAX_IMAGES_PER_PRODUCT,
  MAX_IMAGE_DIMENSION_PX,
  MIN_IMAGE_DIMENSION_PX,
  detectImageSignature,
  extensionMatchesFormat,
  multerErrorMessage,
  parseSingleImageUpload,
  readImageDimensions,
} from "../helpers/imageUpload.helper.js";

// Roles con ALGÚN nivel de acceso administrativo al dominio Product. Un
// `subscriber` (o una request anónima) nunca llega a esta rama: siempre cae en
// las consultas públicas (Regla §24 — el backend es la barrera, no Angular).
const ADMIN_CAPABLE_ROLES = [ROLES.ADMIN, ROLES.SHOP_MANAGER, ROLES.EDITOR];
const isAdminCapable = (role) => ADMIN_CAPABLE_ROLES.includes(role);
const isOwner = (product, user) =>
  !!product.createdBy && !!user?._id && String(product.createdBy) === String(user._id);

const createProduct = async (req, res) => {
  try {
    // Lista blanca por construccion: el cliente NUNCA controla status,
    // isActive ni createdBy. Se fuerzan desde el servidor.
    const inputData = pickAllowed(req.body, PRODUCT_CREATABLE_FIELDS);
    inputData.createdBy = req.user._id;
    inputData.updatedBy = req.user._id;
    // Redundante con el default del schema, pero explícito: todo producto
    // nuevo nace DRAFT + inactivo, sin excepción y sin importar el rol.
    inputData.status = "DRAFT";
    inputData.isActive = false;

    const data = await dbCreateProduct(inputData);
    res.json({
      msg: "Producto creado exitosamente",
      data,
    });
  } catch (error) {
    return sendWriteError(res, error, "producto");
  }
};

// GET /product
//   - Sin sesión admin-capable, o sin `?all=true`  -> SOLO PUBLISHED + isActive
//     (mismo contrato de siempre para el Storefront: público, sin auth).
//   - Con sesión admin-capable Y `?all=true`        -> vista de panel:
//       administrador / shop_manager -> todos los productos (filtrables por ?status=)
//       editor                       -> SOLO los productos de su propiedad
const getProduct = async (req, res) => {
  try {
    const role = req.user?.role;
    const wantsAll = req.query.all === "true";

    if (!wantsAll || !isAdminCapable(role)) {
      const data = await dbGetPublicProducts();
      return res.json({
        msg: "Productos obtenidos exitosamente",
        data,
      });
    }

    let data = await dbGetProduct();
    if (role === ROLES.EDITOR) {
      data = data.filter((p) => isOwner(p, req.user));
    }
    if (req.query.status && PRODUCT_STATUSES.includes(req.query.status)) {
      data = data.filter((p) => p.status === req.query.status);
    }

    // F6 — resuelve nombre de `createdBy`/`workflowHistory[].by` SIEMPRE
    // DESPUÉS del filtro de ownership de arriba (que necesita el ObjectId
    // crudo, ver `populateReviewActors`).
    data = await populateReviewActors(data);

    res.json({
      msg: "Productos obtenidos exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al obtener los productos",
    });
  }
};

// GET /product/:id
//   - admin-capable viendo SU PROPIO producto (o admin/shop_manager, sin
//     restricción de ownership) -> devuelve el documento completo, cualquier
//     estado.
//   - cualquier otro caso (incluida una request anónima, o un editor mirando
//     un producto ajeno) -> se le aplica EXACTAMENTE la regla pública: 404 si
//     no está PUBLISHED + isActive. Nunca se revela información editorial
//     privada de un producto ajeno (Regla §25).
const getProductById = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }

    const role = req.user?.role;
    if (isAdminCapable(role)) {
      const raw = await dbGetProductById(id);
      // F6 — el chequeo de ownership (`isOwner`) va SIEMPRE antes de poblar
      // `createdBy` (necesita el ObjectId crudo, ver `populateReviewActors`).
      if (raw && (role !== ROLES.EDITOR || isOwner(raw, req.user))) {
        const data = await populateReviewActors(raw);
        return res.json({
          msg: "Producto obtenido exitosamente",
          data,
        });
      }
    }

    const data = await dbGetPublicProductById(id);
    if (!data) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }
    res.json({
      msg: "Producto obtenido exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al obtener el producto",
    });
  }
};

// PATCH /product/:id — SOLO contenido editorial. `status` jamás se acepta
// aquí (ver PATCH /product/:id/status). Los campos permitidos dependen del
// rol + estado actual + ownership (`editableFieldsFor`, fuente única de
// verdad del workflow — Regla crítica: el backend nunca confía en que Angular
// ya haya ocultado el botón).
const updateProductById = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }

    // Rechazo TEMPRANO (defensa en profundidad): si el body no trae NINGÚN
    // campo que pudiera ser válido para NINGÚN rol/estado (p. ej. solo trae
    // operadores `$...`, o `createdBy`, o claves inventadas), se corta aquí
    // MISMO, sin tocar Mongoose todavía. El filtro exacto (rol + estado +
    // ownership) llega después, una vez cargado el producto.
    const maybeValid = pickAllowed(req.body, PRODUCT_ALL_UPDATABLE_FIELDS);
    if (Object.keys(maybeValid).length === 0) {
      return res.status(400).json({
        msg: "No se enviaron campos válidos para actualizar",
      });
    }

    const product = await dbGetProductById(id);
    if (!product) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }

    const allowedFields = editableFieldsFor(product, req.user);
    if (allowedFields.length === 0) {
      return res.status(403).json({
        msg:
          "Este producto no admite edición de contenido en su estado actual para tu rol. " +
          "Si ya está publicado, primero debe volver a borrador (edición controlada) para reabrir el ciclo de revisión.",
      });
    }

    const inputData = pickAllowed(req.body, allowedFields);
    if (Object.keys(inputData).length === 0) {
      return res.status(400).json({
        msg: "No se enviaron campos válidos para actualizar",
      });
    }

    // PD2-002 — Invariante isActive: un producto solo puede quedar ACTIVO si
    // está PUBLISHED. `isActive:false` sobre cualquier estado es inofensivo
    // (idempotente, ya lo está); `isActive:true` sobre un no-publicado se
    // rechaza — la única vía de activación es el flujo de revisión
    // (APPROVED -> PUBLISHED), nunca un PATCH de contenido.
    if (inputData.isActive === true && product.status !== PRODUCT_STATUS.PUBLISHED) {
      return res.status(400).json({
        msg:
          "Solo un producto PUBLISHED puede activarse (isActive:true). " +
          "Para publicarlo, usa el flujo de revisión: PATCH /product/:id/status.",
      });
    }

    // Nunca proviene del body: se deriva siempre del usuario autenticado.
    inputData.updatedBy = req.user._id;

    const data = await dbUpdateProductById(id, inputData);
    if (!data) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }
    res.json({
      msg: "Producto actualizado exitosamente",
      data,
    });
  } catch (error) {
    return sendWriteError(res, error, "producto");
  }
};

// PATCH /product/:id/status — ÚNICO punto de entrada para mover el workflow.
// Toda transición se valida contra la tabla de `productWorkflow.helper.js`
// (rol + ownership + estado origen/destino). El cliente nunca puede alcanzar
// PUBLISHED saltándose PENDING_REVIEW/APPROVED, sin importar lo que Angular
// muestre u oculte.
const updateProductStatus = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }

    // FASE 1 — `comment` es el campo general del comentario de revisión (queda
    // en workflowHistory). `rejectionReason` se sigue aceptando como ALIAS por
    // compatibilidad de contrato con el frontend/Bruno existentes.
    const { toStatus, rejectionReason, comment } = req.body ?? {};
    if (!toStatus || !PRODUCT_STATUSES.includes(toStatus)) {
      return res.status(400).json({
        msg: "Debes indicar un `toStatus` válido",
      });
    }

    const rawComment = comment ?? rejectionReason;
    const effectiveComment = rawComment == null ? "" : String(rawComment).trim();

    const product = await dbGetProductById(id);
    if (!product) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }

    // PD-004 — Estado leído AHORA. La escritura solo se aplicará si el producto
    // sigue en este estado (filtro atómico en `dbUpdateProductStatus`).
    const fromStatus = product.status;

    const check = canTransitionProduct(product, toStatus, req.user);
    if (!check.ok) {
      return res.status(403).json({
        msg: transitionErrorMessage(check.reason),
      });
    }

    // PD2-009 — Completitud comercial. Un DRAFT puede estar incompleto, pero
    // un producto incompleto no puede AVANZAR hacia publicación. Se valida en
    // los dos puntos donde el ciclo progresa: enviar a revisión y publicar
    // (defensa en profundidad — el administrador puede haber editado contenido
    // de un APPROVED). Fuente de verdad ÚNICA para ambos: collectSubmitReviewErrors.
    if (toStatus === "PENDING_REVIEW" || toStatus === "PUBLISHED") {
      const errors = collectSubmitReviewErrors(product);
      if (errors.length > 0) {
        return res.status(400).json({
          msg:
            toStatus === "PUBLISHED"
              ? "El producto no cumple los requisitos mínimos para publicarse"
              : "El producto no cumple los requisitos mínimos para enviarse a revisión",
          errors,
        });
      }
    }

    // FASE 1 — REJECTED y CHANGES_REQUESTED exigen un comentario no vacío
    // (`rule.requiresComment`). El comentario se guarda en workflowHistory (y,
    // solo para REJECTED, además en `rejectionReason` como espejo de compat).
    if (check.rule?.requiresComment && !effectiveComment) {
      return res.status(400).json({
        msg:
          toStatus === "REJECTED"
            ? "Debes indicar un motivo de rechazo"
            : "Debes indicar un comentario con los cambios solicitados",
      });
    }

    const update = { status: toStatus, updatedBy: req.user._id };
    const now = new Date();
    if (toStatus === "PENDING_REVIEW") {
      update.submittedBy = req.user._id;
      update.submittedAt = now;
      // PD2-002 — nada que no sea PUBLISHED queda activo.
      update.isActive = false;
    }
    if (toStatus === "CHANGES_REQUESTED") {
      // FASE 1 — el "quién/cuándo/comentario" vive en workflowHistory, no en
      // campos dedicados (§10). Solo se fuerza la invariante de visibilidad.
      update.isActive = false;
    }
    if (toStatus === "APPROVED") {
      update.approvedBy = req.user._id;
      update.approvedAt = now;
      // PD2-002 — aprobado != publicado: sigue inactivo hasta PUBLISHED.
      update.isActive = false;
    }
    if (toStatus === "REJECTED") {
      update.rejectedBy = req.user._id;
      update.rejectedAt = now;
      update.rejectionReason = effectiveComment;
      // Un producto rechazado nunca es visible (defensivo: ya venia de
      // PENDING_REVIEW, donde isActive ya era false).
      update.isActive = false;
    }
    if (toStatus === "PUBLISHED") {
      update.publishedBy = req.user._id;
      update.publishedAt = now;
      // "Publicar" ES activar: nace visible de inmediato, sin un segundo paso
      // manual. A partir de aqui, isActive es la palanca operativa normal
      // (Decision §3: el administrador puede desactivar/reactivar sin repetir
      // el workflow completo).
      update.isActive = true;
    }
    if (toStatus === "DRAFT") {
      // "Edicion controlada" (PUBLISHED -> DRAFT), reapertura tras rechazo
      // (REJECTED -> DRAFT) o revivir un archivado (ARCHIVED -> DRAFT): un
      // DRAFT nunca debe quedar marcado como activo.
      update.isActive = false;
    }
    if (toStatus === "ARCHIVED") {
      // FASE 1 / F1-CLOSURE-3 — retirado del catálogo. Nunca activo, nunca
      // público. `publishedBy`/`publishedAt` SE CONSERVAN como dato histórico
      // (ver METADATA_VALID_IN_STATUS.ARCHIVED); el resto de metadata de ciclo
      // se limpia y su rastro completo queda en workflowHistory.
      update.isActive = false;
    }

    // PD2-001 — En la MISMA escritura atómica se limpia la metadata de
    // workflow que ya no corresponde al estado destino (p. ej. `publishedAt`
    // al volver a DRAFT, `rejectionReason` al reabrir un ciclo de revisión).
    const staleMetadata = staleWorkflowMetadata(toStatus, Object.keys(update));

    // FASE 1 — bitácora append-only. Se escribe con `$push` en la MISMA
    // operación atómica del cambio de estado (misma condición `status: fromStatus`).
    const historyEntry = {
      action: workflowActionFor(fromStatus, toStatus),
      fromStatus,
      toStatus,
      by: req.user._id,
      at: now,
      ...(effectiveComment ? { comment: effectiveComment } : {}),
    };

    const data = await dbUpdateProductStatus(id, fromStatus, update, staleMetadata, historyEntry);
    if (!data) {
      // PD-004 — Otra operación cambió el estado entre la lectura y la escritura.
      return res.status(409).json({
        msg:
          "El producto cambió de estado mientras se procesaba tu solicitud. " +
          "Vuelve a cargarlo e inténtalo de nuevo.",
      });
    }
    res.json({
      msg: "Estado del producto actualizado exitosamente",
      data,
    });
  } catch (error) {
    return sendWriteError(res, error, "producto");
  }
};

// Mensaje 403 compartido con `updateProductById` — MISMA regla de negocio:
// "puede editar contenido de este producto" (rol + estado + ownership,
// `editableFieldsFor`). Las imágenes son parte de `PRODUCT_CONTENT_FIELDS`
// (`productWorkflow.helper.js`), así que 'images' SIEMPRE aparece en la lista
// devuelta cuando el usuario puede editar contenido, y NUNCA si no puede —
// reutilizar `editableFieldsFor` es lo que garantiza que el upload/borrado de
// imágenes no pueda usarse como atajo para saltarse ownership o el estado del
// workflow (Regla F4 — "no puede utilizar un endpoint de imágenes para
// saltarse ownership").
const CONTENT_LOCKED_MSG =
  "Este producto no admite edición de contenido en su estado actual para tu rol. " +
  "Si ya está publicado, primero debe volver a borrador (edición controlada) para reabrir el ciclo de revisión.";

// POST /product/:id/images — upload REAL intermediado por backend (Cloudinary
// nunca ve al cliente directamente; ver "Arquitectura Cloudinary elegida" en
// el reporte F4). Flujo: autorización de dominio -> límite de cantidad ->
// multer (multipart, memoria) -> validación de contenido real (magic bytes +
// extensión + dimensiones, TODA independiente de lo que declare el
// navegador) -> Cloudinary -> persistencia atómica ($push) -> respuesta.
//
// Manejo de fallos (Regla F4 — nunca huérfanos innecesarios, nunca un
// producto "a medias"):
//   - Cloudinary rechaza/timeout/red     -> nada se escribe en Mongo; 502.
//   - Cloudinary OK pero Mongo falla     -> se intenta revertir el asset recién
//                                            subido (`cloudinaryImageService.destroy`,
//                                            best-effort) antes de responder.
const uploadProductImage = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ msg: "El ID del producto no es válido" });
    }

    const product = await dbGetProductById(id);
    if (!product) {
      return res.status(404).json({ msg: "El producto no se encuentra registrado" });
    }

    const allowedFields = editableFieldsFor(product, req.user);
    if (!allowedFields.includes("images")) {
      return res.status(403).json({ msg: CONTENT_LOCKED_MSG });
    }

    if ((product.images?.length ?? 0) >= MAX_IMAGES_PER_PRODUCT) {
      return res.status(400).json({
        msg: `Se alcanzó el máximo de imágenes por producto (${MAX_IMAGES_PER_PRODUCT}).`,
      });
    }

    // multer: parsea el multipart a `req.file` (buffer en memoria). Cualquier
    // error (tamaño, tipo declarado, campo inesperado) se traduce a un 400
    // de negocio — nunca se reenvía el error crudo de la librería.
    try {
      await parseSingleImageUpload(req, res);
    } catch (uploadErr) {
      return res.status(400).json({ msg: multerErrorMessage(uploadErr) });
    }

    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ msg: "Debes seleccionar un archivo de imagen." });
    }

    // --- Validación REAL de contenido (independiente del Content-Type que
    // haya declarado el navegador): firma binaria, extensión coherente y
    // dimensiones dentro de rango. Cualquier archivo no-imagen disfrazado,
    // corrupto, o con extensión falsa se detiene aquí, ANTES de tocar Cloudinary.
    const format = detectImageSignature(req.file.buffer);
    if (!format) {
      return res.status(400).json({ msg: "Tipo de archivo no permitido. Usa JPEG, PNG o WEBP." });
    }
    if (!extensionMatchesFormat(req.file.originalname, format)) {
      return res.status(400).json({
        msg: "La extensión del archivo no coincide con su contenido real.",
      });
    }
    const dimensions = readImageDimensions(req.file.buffer, format);
    if (!dimensions) {
      return res.status(400).json({ msg: "El archivo de imagen está dañado o no se pudo procesar." });
    }
    if (dimensions.width < MIN_IMAGE_DIMENSION_PX || dimensions.height < MIN_IMAGE_DIMENSION_PX) {
      return res.status(400).json({
        msg: `La imagen es demasiado pequeña (mínimo ${MIN_IMAGE_DIMENSION_PX}x${MIN_IMAGE_DIMENSION_PX} píxeles).`,
      });
    }
    if (dimensions.width > MAX_IMAGE_DIMENSION_PX || dimensions.height > MAX_IMAGE_DIMENSION_PX) {
      return res.status(400).json({
        msg: `La imagen supera las dimensiones máximas permitidas (${MAX_IMAGE_DIMENSION_PX}x${MAX_IMAGE_DIMENSION_PX} píxeles).`,
      });
    }

    let uploaded;
    try {
      uploaded = await cloudinaryImageService.upload(req.file.buffer, String(product._id));
    } catch (cloudErr) {
      console.error(`uploadProductImage -> cloudinary upload failed: ${cloudErr && cloudErr.name}`);
      return res.status(502).json({ msg: "No fue posible subir la imagen. Inténtalo nuevamente." });
    }

    // FASE 4-CLOSURE — `dbAddProductImage` decide `isMain`/`order`/el límite
    // de forma ATÓMICA (filtros evaluados por Mongo en el instante de la
    // escritura, nunca contra la lectura de `product` de arriba, que puede
    // estar desactualizada frente a otro upload concurrente al mismo
    // producto — ver el comentario extenso en product.services.js). El
    // chequeo de límite de más arriba sigue existiendo como fast-path (evita
    // gastar un upload a Cloudinary en el caso común, no-concurrente); este
    // es el que de verdad garantiza la invariante.
    const { product: updated, limitReached } = await dbAddProductImage(id, {
      url: uploaded.url,
      publicId: uploaded.publicId,
      alt: "",
    });
    if (!updated) {
      // ORPHAN — Cloudinary confirmó el asset pero la escritura en Mongo no
      // se aplicó: o el producto ya no existe (borrado concurrente), o se
      // perdió la carrera del límite máximo justo en el último instante. En
      // ambos casos se revierte el asset (best-effort) en vez de dejarlo huérfano.
      await cloudinaryImageService.destroy(uploaded.publicId);
      if (limitReached) {
        return res.status(400).json({
          msg: `Se alcanzó el máximo de imágenes por producto (${MAX_IMAGES_PER_PRODUCT}).`,
        });
      }
      return res.status(404).json({ msg: "El producto no se encuentra registrado" });
    }

    res.json({ msg: "Imagen subida exitosamente", data: updated });
  } catch (error) {
    return sendWriteError(res, error, "imagen del producto");
  }
};

// DELETE /product/:id/images/:imageId — borra UNA imagen de UN producto.
// `imageId` SIEMPRE se resuelve contra `product.images` del `:id` de la URL
// (nunca contra la colección completa ni contra un `publicId` que mande el
// cliente): un `imageId` que no pertenezca a este producto responde 404, sin
// filtrar si existe en otro producto — imposible usar este endpoint para
// borrar el asset de Cloudinary de un producto ajeno (Regla F4 — "no aceptar
// arbitrary publicId del cliente" / "no cross-product deletion").
const deleteProductImage = async (req, res) => {
  try {
    const id = req.params.id;
    const imageId = req.params.imageId;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(imageId)) {
      return res.status(400).json({ msg: "El ID del producto o de la imagen no es válido" });
    }

    const product = await dbGetProductById(id);
    if (!product) {
      return res.status(404).json({ msg: "El producto no se encuentra registrado" });
    }

    const allowedFields = editableFieldsFor(product, req.user);
    if (!allowedFields.includes("images")) {
      return res.status(403).json({ msg: CONTENT_LOCKED_MSG });
    }

    const result = await dbRemoveProductImage(id, imageId);
    if (!result.found) {
      return res.status(404).json({ msg: "La imagen no se encuentra en este producto" });
    }

    res.json({ msg: "Imagen eliminada exitosamente", data: result.product });
  } catch (error) {
    return sendWriteError(res, error, "imagen del producto");
  }
};

const deleteProductById = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }
    const data = await dbDeleteProductById(id);
    if (!data) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }
    res.json({
      msg: "Producto eliminado exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al eliminar el producto",
    });
  }
};

export {
  createProduct,
  getProduct,
  getProductById,
  updateProductById,
  updateProductStatus,
  uploadProductImage,
  deleteProductImage,
  deleteProductById,
};
