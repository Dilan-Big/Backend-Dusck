import mongoose from "mongoose";

import {
  dbCreateProduct,
  dbDeleteProductById,
  dbGetProduct,
  dbGetProductById,
  dbGetPublicProducts,
  dbGetPublicProductById,
  dbUpdateProductById,
  dbUpdateProductStatus,
} from "../services/product.services.js";
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
} from "../helpers/productWorkflow.helper.js";
import { pickAllowed } from "../helpers/validation.helpers.js";
import { sendWriteError } from "../helpers/writeError.helper.js";

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
      if (raw && (role !== ROLES.EDITOR || isOwner(raw, req.user))) {
        return res.json({
          msg: "Producto obtenido exitosamente",
          data: raw,
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

    const { toStatus, rejectionReason } = req.body ?? {};
    if (!toStatus || !PRODUCT_STATUSES.includes(toStatus)) {
      return res.status(400).json({
        msg: "Debes indicar un `toStatus` válido",
      });
    }

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

    if (toStatus === "REJECTED" && (!rejectionReason || !String(rejectionReason).trim())) {
      return res.status(400).json({
        msg: "Debes indicar un motivo de rechazo",
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
    if (toStatus === "APPROVED") {
      update.approvedBy = req.user._id;
      update.approvedAt = now;
      // PD2-002 — aprobado != publicado: sigue inactivo hasta PUBLISHED.
      update.isActive = false;
    }
    if (toStatus === "REJECTED") {
      update.rejectedBy = req.user._id;
      update.rejectedAt = now;
      update.rejectionReason = String(rejectionReason).trim();
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
      // "Edicion controlada" (PUBLISHED -> DRAFT) o reapertura tras rechazo
      // (REJECTED -> DRAFT): un DRAFT nunca debe quedar marcado como activo.
      update.isActive = false;
    }

    // PD2-001 — En la MISMA escritura atómica se limpia la metadata de
    // workflow que ya no corresponde al estado destino (p. ej. `publishedAt`
    // al volver a DRAFT, `rejectionReason` al reabrir un ciclo de revisión).
    const staleMetadata = staleWorkflowMetadata(toStatus, Object.keys(update));

    const data = await dbUpdateProductStatus(id, fromStatus, update, staleMetadata);
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
  deleteProductById,
};
