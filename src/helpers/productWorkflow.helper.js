// FASE 3 — Product Domain + Editor Workflow.
//
// Fuente única de verdad del ciclo de vida editorial de Product:
//   - estados válidos y transiciones permitidas (por rol + ownership);
//   - qué campos de CONTENIDO puede escribir cada rol según el estado actual;
//   - validación mínima para poder pasar DRAFT -> PENDING_REVIEW.
//
// El backend es la autoridad. Nada de esto se duplica de forma distinta en
// Angular: el frontend solo oculta acciones que este módulo ya prohibiría.

import { ROLES } from "../config/global.config.js";

// --- Estados ---------------------------------------------------------------

export const PRODUCT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  PENDING_REVIEW: "PENDING_REVIEW",
  // FASE 1 — el administrador ve viable el producto pero pide correcciones. El
  // editor propietario puede editar contenido en este estado y reenviarlo a
  // revision (RESUBMIT). NO es equivalente a REJECTED (ver §7 de la fase).
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PUBLISHED: "PUBLISHED",
  // FASE 1 — producto retirado del catalogo. NO es un DELETE fisico: el
  // documento y su historial se conservan. Nunca visible en el storefront.
  ARCHIVED: "ARCHIVED",
});

export const PRODUCT_STATUSES = Object.values(PRODUCT_STATUS);

// --- Acciones del workflow (FASE 1) ---------------------------------------
//
// Nombre estable de CADA arista del grafo, para registrarlo en
// `product.workflowHistory[].action`. Se deriva de (fromStatus, toStatus) con
// `workflowActionFor()` — el controller no lo recibe del cliente.
export const WORKFLOW_ACTION = Object.freeze({
  SUBMIT: "submit",
  RESUBMIT: "resubmit",
  REQUEST_CHANGES: "request_changes",
  APPROVE: "approve",
  REJECT: "reject",
  PUBLISH: "publish",
  ARCHIVE: "archive",
  REOPEN: "reopen",
});

export const WORKFLOW_ACTIONS = Object.values(WORKFLOW_ACTION);

/**
 * Nombre de accion para la transicion `fromStatus -> toStatus`. Solo se invoca
 * DESPUES de que `canTransitionProduct` valido que la arista existe, asi que el
 * `default` es defensivo y en la practica no se alcanza.
 */
export function workflowActionFor(fromStatus, toStatus) {
  const key = `${fromStatus}->${toStatus}`;
  switch (key) {
    case "DRAFT->PENDING_REVIEW":
      return WORKFLOW_ACTION.SUBMIT;
    case "CHANGES_REQUESTED->PENDING_REVIEW":
      return WORKFLOW_ACTION.RESUBMIT;
    case "PENDING_REVIEW->CHANGES_REQUESTED":
      return WORKFLOW_ACTION.REQUEST_CHANGES;
    case "PENDING_REVIEW->APPROVED":
      return WORKFLOW_ACTION.APPROVE;
    case "PENDING_REVIEW->REJECTED":
      return WORKFLOW_ACTION.REJECT;
    case "APPROVED->PUBLISHED":
      return WORKFLOW_ACTION.PUBLISH;
    case "PUBLISHED->ARCHIVED":
    case "REJECTED->ARCHIVED":
      return WORKFLOW_ACTION.ARCHIVE;
    case "REJECTED->DRAFT":
    case "CHANGES_REQUESTED->DRAFT":
    case "PUBLISHED->DRAFT":
    case "ARCHIVED->DRAFT":
      return WORKFLOW_ACTION.REOPEN;
    default:
      return WORKFLOW_ACTION.REOPEN;
  }
}

// --- Metadata de workflow: qué campos siguen siendo COHERENTES por estado ---
//
// PD2-001 — Cada cambio de estado abre o cierra una parte del ciclo editorial.
// La metadata que NO pertenece al estado destino se limpia ($unset) en la
// misma transición atómica, para que un ciclo nuevo no herede información
// engañosa de uno anterior (un DRAFT reabierto que todavía muestra
// `publishedAt`, o un producto republicado que arrastra el `rejectionReason`
// de un rechazo ya resuelto).
//
// `createdBy` / `updatedBy` NO son metadata de ciclo: son identidad y
// auditoría permanente del documento y nunca se tocan aquí.
export const WORKFLOW_METADATA_FIELDS = Object.freeze([
  "submittedBy",
  "submittedAt",
  "approvedBy",
  "approvedAt",
  "rejectedBy",
  "rejectedAt",
  "rejectionReason",
  "publishedBy",
  "publishedAt",
]);

// Para cada estado, el subconjunto de WORKFLOW_METADATA_FIELDS que tiene
// sentido CONSERVAR. Todo lo demás se elimina al entrar a ese estado.
//   DRAFT           -> ciclo nuevo: no arrastra nada.
//   PENDING_REVIEW  -> solo el envío actual.
//   APPROVED        -> envío + aprobación actuales (sin rastro de rechazo previo).
//   REJECTED        -> envío + rechazo actuales (sin rastro de aprobación previa).
//   PUBLISHED       -> envío + aprobación + publicación (sin rastro de rechazo).
const METADATA_VALID_IN_STATUS = Object.freeze({
  [PRODUCT_STATUS.DRAFT]: [],
  [PRODUCT_STATUS.PENDING_REVIEW]: ["submittedBy", "submittedAt"],
  // CHANGES_REQUESTED conserva el ENVIO actual (fue enviado, solo necesita
  // correcciones). El comentario del admin NO va aqui: vive en workflowHistory.
  [PRODUCT_STATUS.CHANGES_REQUESTED]: ["submittedBy", "submittedAt"],
  [PRODUCT_STATUS.APPROVED]: ["submittedBy", "submittedAt", "approvedBy", "approvedAt"],
  [PRODUCT_STATUS.REJECTED]: [
    "submittedBy",
    "submittedAt",
    "rejectedBy",
    "rejectedAt",
    "rejectionReason",
  ],
  [PRODUCT_STATUS.PUBLISHED]: [
    "submittedBy",
    "submittedAt",
    "approvedBy",
    "approvedAt",
    "publishedBy",
    "publishedAt",
  ],
  // ARCHIVED — F1-CLOSURE-3: se CONSERVA `publishedBy` / `publishedAt` como
  // dato histórico (New Arrivals / auditoría / análisis lo usarán en fases
  // posteriores). El resto de metadata de ciclo (submit/approve/reject) se
  // limpia — su rastro completo vive en workflowHistory. Si el producto se
  // archivó SIN haber estado publicado (REJECTED -> ARCHIVED), simplemente no
  // hay `publishedAt` que conservar. Al revivir (ARCHIVED -> DRAFT) se aplica
  // la política de DRAFT (pizarra limpia), igual que PUBLISHED -> DRAFT.
  [PRODUCT_STATUS.ARCHIVED]: ["publishedBy", "publishedAt"],
});

/**
 * Campos de metadata de workflow que deben ELIMINARSE ($unset) al entrar a
 * `toStatus`. Excluye los que la transición está escribiendo ahora mismo
 * (`fieldsBeingSet`), que por definición sí pertenecen al estado destino.
 */
export function staleWorkflowMetadata(toStatus, fieldsBeingSet = []) {
  const valid = new Set(METADATA_VALID_IN_STATUS[toStatus] || []);
  const beingSet = new Set(fieldsBeingSet);
  return WORKFLOW_METADATA_FIELDS.filter((f) => !valid.has(f) && !beingSet.has(f));
}

// --- Campos ------------------------------------------------------------

// Campos de "contenido" editorial (todo lo que NO es status/isActive/auditoria).
export const PRODUCT_CONTENT_FIELDS = [
  "name",
  "slug",
  "description",
  "categories",
  "images",
  "price",
  "variants",
  "stock",
  // FASE 1 — contenido editorial nuevo (aditivo). El editor propietario los
  // puede escribir en DRAFT / REJECTED / CHANGES_REQUESTED, igual que el resto
  // del contenido; `editableFieldsFor()` los incluye por construccion.
  "modelInfo",
  "details",
  "shippingInfo",
  "returnsInfo",
];

// Campos aceptados en la creación (POST). NUNCA incluye status/isActive/createdBy:
// esos los fuerza el controller desde el servidor, jamás desde el body del cliente.
export const PRODUCT_CREATABLE_FIELDS = [...PRODUCT_CONTENT_FIELDS];

// Unión de TODO lo que PODRÍA llegar a ser editable en un PATCH /product/:id,
// para CUALQUIER rol/estado combinados (contenido + isActive). Se usa como
// filtro sintáctico temprano (sin necesidad de cargar el documento todavía);
// `editableFieldsFor()` es la lista blanca REAL, ya acotada por rol + estado
// + ownership.
export const PRODUCT_ALL_UPDATABLE_FIELDS = [...PRODUCT_CONTENT_FIELDS, "isActive"];

// --- Transiciones de estado --------------------------------------------
//
// Cada entrada describe una arista válida del grafo de estados:
//   roles:      quién puede ejecutarla.
//   ownerOnly:  si es true, un usuario con rol `editor` SOLO puede ejecutarla
//               sobre un producto cuyo `createdBy` sea el suyo. `administrador`
//               y `shop_manager` nunca están sujetos a ownership (conservan la
//               autoridad de catálogo que ya tenían).
//   requiresReason:  exige `rejectionReason` no vacío en el body (compat).
//   requiresComment: (FASE 1) exige un comentario no vacío en el body
//                    (`comment`, con `rejectionReason` aceptado como alias).
//                    Usado por REJECTED y CHANGES_REQUESTED.
//
// PUBLISHED -> DRAFT es la "edición controlada": el único camino para tocar
// contenido de un producto ya publicado es sacarlo de PUBLISHED primero y
// reiniciar el ciclo completo. Ni editor ni shop_manager pueden saltarse esto.
//
// FASE 1 — conflicto documentado (§7): `REJECTED -> DRAFT` (editor propietario)
// se CONSERVA tal cual. Quitarla o restringirla a admin rompe tests y contratos
// existentes (product-workflow, pd2-remediation). La separación REJECTED vs
// CHANGES_REQUESTED se logra AÑADIENDO CHANGES_REQUESTED como vía "blanda"
// (el editor edita en sitio y hace RESUBMIT directo), no endureciendo REJECTED.
// El editor nunca PUEDE fijar REJECTED (solo el admin lo hace desde
// PENDING_REVIEW), así que no puede usarlo como sucedáneo de CHANGES_REQUESTED.
const T = (from, to) => `${from}->${to}`;

export const PRODUCT_TRANSITIONS = Object.freeze({
  [T(PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.PENDING_REVIEW)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
  },
  [T(PRODUCT_STATUS.PENDING_REVIEW, PRODUCT_STATUS.APPROVED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
  },
  [T(PRODUCT_STATUS.PENDING_REVIEW, PRODUCT_STATUS.REJECTED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
    requiresReason: true,
    requiresComment: true,
  },
  // FASE 1 — el admin pide correcciones. Exige comentario (queda en
  // workflowHistory). El editor propietario recupera el control del contenido.
  [T(PRODUCT_STATUS.PENDING_REVIEW, PRODUCT_STATUS.CHANGES_REQUESTED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
    requiresComment: true,
  },
  // FASE 1 — RESUBMIT: el editor propietario reenvía tras corregir.
  [T(PRODUCT_STATUS.CHANGES_REQUESTED, PRODUCT_STATUS.PENDING_REVIEW)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
  },
  // FASE 1 — el editor propietario también puede aparcar en borrador.
  [T(PRODUCT_STATUS.CHANGES_REQUESTED, PRODUCT_STATUS.DRAFT)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
  },
  [T(PRODUCT_STATUS.REJECTED, PRODUCT_STATUS.DRAFT)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
  },
  // FASE 1 — el admin archiva un rechazo definitivo.
  [T(PRODUCT_STATUS.REJECTED, PRODUCT_STATUS.ARCHIVED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
  },
  [T(PRODUCT_STATUS.APPROVED, PRODUCT_STATUS.PUBLISHED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
  },
  // "Edición controlada": vuelve un producto publicado a borrador para poder
  // tocar contenido. isActive NO se toca aquí (se maneja aparte, ver §PUBLISHED+isActive).
  [T(PRODUCT_STATUS.PUBLISHED, PRODUCT_STATUS.DRAFT)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
  },
  // FASE 1 — el admin retira un producto publicado del catálogo (no es DELETE).
  [T(PRODUCT_STATUS.PUBLISHED, PRODUCT_STATUS.ARCHIVED)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
  },
  // FASE 1 — revivir: solo el admin reabre un producto archivado, a DRAFT
  // (ciclo editorial completo de nuevo). NO vuelve directo a PUBLISHED.
  [T(PRODUCT_STATUS.ARCHIVED, PRODUCT_STATUS.DRAFT)]: {
    roles: [ROLES.ADMIN],
    ownerOnly: false,
  },
});

/**
 * ¿Puede `user` ejecutar la transición `product.status -> toStatus`?
 * Devuelve { ok: true } o { ok: false, reason }.
 */
export function canTransitionProduct(product, toStatus, user) {
  if (!PRODUCT_STATUSES.includes(toStatus)) {
    return { ok: false, reason: "invalid-status" };
  }

  const rule = PRODUCT_TRANSITIONS[T(product.status, toStatus)];
  if (!rule) {
    return { ok: false, reason: "transition-not-allowed" };
  }

  if (!rule.roles.includes(user?.role)) {
    return { ok: false, reason: "role-not-allowed" };
  }

  // Ownership: SOLO aplica al rol `editor`. administrador y shop_manager
  // actúan sobre cualquier producto, igual que ya podían hacer con el CRUD.
  if (rule.ownerOnly && user.role === ROLES.EDITOR) {
    const ownerId = product.createdBy ? String(product.createdBy) : null;
    if (!ownerId || ownerId !== String(user._id)) {
      return { ok: false, reason: "not-owner" };
    }
  }

  return { ok: true, rule };
}

export function transitionErrorMessage(reason) {
  switch (reason) {
    case "invalid-status":
      return "El estado destino no es válido";
    case "transition-not-allowed":
      return "Esa transición de estado no está permitida desde el estado actual";
    case "role-not-allowed":
      return "Tu rol no tiene autorización para realizar esta transición";
    case "not-owner":
      return "Solo el editor propietario del producto puede realizar esta transición";
    default:
      return "Transición de estado no permitida";
  }
}

// --- Campos editables por rol + estado ----------------------------------
//
// Regla central del §1/§2 de las decisiones aprobadas:
//   - administrador: contenido editable SIEMPRE (autoridad final) + isActive.
//   - shop_manager:  contenido editable SOLO en DRAFT/REJECTED (igual que
//                    editor); isActive editable siempre (palanca operativa,
//                    no de aprobación). Nunca puede editar contenido de un
//                    producto PUBLISHED/APPROVED/PENDING_REVIEW.
//   - editor:        contenido editable SOLO en DRAFT/REJECTED/CHANGES_REQUESTED
//                    Y solo si es el dueño (`createdBy`). Nunca puede tocar
//                    `isActive` (palanca de publicación, y el editor no publica).
//   - cualquier otro rol: sin campos editables.
//
// FASE 1 — CHANGES_REQUESTED se añade a los estados con contenido desbloqueado:
// su razón de ser es que el editor corrija el producto en sitio y lo reenvíe.
const CONTENT_UNLOCKED_STATUSES = new Set([
  PRODUCT_STATUS.DRAFT,
  PRODUCT_STATUS.REJECTED,
  PRODUCT_STATUS.CHANGES_REQUESTED,
]);

export function editableFieldsFor(product, user) {
  const role = user?.role;

  if (role === ROLES.ADMIN) {
    return [...PRODUCT_CONTENT_FIELDS, "isActive"];
  }

  const contentUnlocked = CONTENT_UNLOCKED_STATUSES.has(product.status);

  if (role === ROLES.SHOP_MANAGER) {
    return contentUnlocked ? [...PRODUCT_CONTENT_FIELDS, "isActive"] : ["isActive"];
  }

  if (role === ROLES.EDITOR) {
    if (!contentUnlocked) return [];
    const ownerId = product.createdBy ? String(product.createdBy) : null;
    if (!ownerId || ownerId !== String(user._id)) return [];
    return [...PRODUCT_CONTENT_FIELDS];
  }

  return [];
}

// --- Validación mínima para DRAFT -> PENDING_REVIEW ----------------------
//
// El draft permite información incompleta. Enviar a revisión NO. Esta función
// es la ÚNICA fuente de verdad de "qué hace falta"; Angular puede replicarla
// para UX, pero el backend la exige siempre, sin excepción.
//
// FASE 1 — reglas explícitas de obligatoriedad (§12 de la fase):
//   - GUARDAR DRAFT (PATCH /product/:id): sin exigencias nuevas — un borrador
//     puede estar tan incompleto como haga falta.
//   - ENVIAR A REVISIÓN (DRAFT/CHANGES_REQUESTED -> PENDING_REVIEW) y PUBLICAR
//     (APPROVED -> PUBLISHED): se exige, ADEMÁS de lo que ya se exigía,
//       · `details`      no vacío
//       · `shippingInfo` no vacío
//       · `returnsInfo`  no vacío
//       · exactamente una imagen principal (`images[].isMain === true`)
//   - `modelInfo` es OPCIONAL incluso para revisión: no todo producto lleva
//     modelo. Si viene, el schema valida `heightCm` (rango + tipo numérico).
//   Los campos nuevos NO son `required` en el schema -> los productos ya
//   existentes siguen siendo documentos válidos (solo no podrían re-enviarse
//   a revisión sin completarlos, que es justo el comportamiento buscado).
export function collectSubmitReviewErrors(product) {
  const errors = [];

  if (!product.name || String(product.name).trim().length < 2) {
    errors.push("El nombre es obligatorio (mínimo 2 caracteres).");
  }
  if (!product.slug || !product.slug.trim()) {
    errors.push("El slug es obligatorio.");
  }
  if (!product.description || !product.description.trim()) {
    errors.push("La descripción es obligatoria para enviar a revisión.");
  }
  if (!Array.isArray(product.categories) || product.categories.length === 0) {
    errors.push("Debe asignar al menos una categoría.");
  }
  if (product.price === undefined || product.price === null || Number(product.price) <= 0) {
    errors.push("El precio debe ser mayor que 0.");
  }
  if (!product.details || !String(product.details).trim()) {
    errors.push("Los detalles del producto son obligatorios para enviar a revisión.");
  }
  if (!product.shippingInfo || !String(product.shippingInfo).trim()) {
    errors.push("La información de envíos es obligatoria para enviar a revisión.");
  }
  if (!product.returnsInfo || !String(product.returnsInfo).trim()) {
    errors.push("La información de cambios y devoluciones es obligatoria para enviar a revisión.");
  }
  if (!Array.isArray(product.images) || product.images.length === 0) {
    errors.push("Debe cargar al menos una imagen.");
  } else if (!product.images.some((img) => img && img.isMain === true)) {
    // Defensa en profundidad: `normalizeProductImages` en el service ya
    // garantiza exactamente una imagen principal cuando hay imágenes, pero un
    // documento legado / manipulado podría no tenerla.
    errors.push("Debe marcar una imagen como principal.");
  }

  if (Array.isArray(product.variants) && product.variants.length > 0) {
    product.variants.forEach((v, i) => {
      if (!v.sku || !String(v.sku).trim()) errors.push(`La variante #${i + 1} necesita un SKU.`);
      if (!v.color || !String(v.color).trim()) errors.push(`La variante #${i + 1} necesita un color.`);
      // F5-CLOSURE — talla obligatoria. El schema (product.model.js) ya
      // bloquea esto en escrituras NUEVAS/actualizadas; este chequeo cubre el
      // caso de un producto LEGACY (talla vacía persistida antes del cierre,
      // nunca migrada) que intenta avanzar de estado sin haber corregido esa
      // variante — mismo patrón que sku/color arriba.
      if (!v.size || !String(v.size).trim()) {
        errors.push(`La variante #${i + 1} necesita una talla (usa "Única" si el producto no tiene tallaje).`);
      }
      if (v.stock === undefined || v.stock === null || Number(v.stock) < 0) {
        errors.push(`La variante #${i + 1} necesita un stock válido (≥ 0).`);
      }
    });
  } else if (product.stock === undefined || product.stock === null || Number(product.stock) < 0) {
    errors.push("El stock es obligatorio (≥ 0) para productos sin variantes.");
  }

  return errors;
}
