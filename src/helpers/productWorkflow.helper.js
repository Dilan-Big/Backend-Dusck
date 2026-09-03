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
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PUBLISHED: "PUBLISHED",
});

export const PRODUCT_STATUSES = Object.values(PRODUCT_STATUS);

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
//   requiresReason: exige `rejectionReason` no vacío en el body.
//
// PUBLISHED -> DRAFT es la "edición controlada": el único camino para tocar
// contenido de un producto ya publicado es sacarlo de PUBLISHED primero y
// reiniciar el ciclo completo. Ni editor ni shop_manager pueden saltarse esto.
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
  },
  [T(PRODUCT_STATUS.REJECTED, PRODUCT_STATUS.DRAFT)]: {
    roles: [ROLES.EDITOR, ROLES.SHOP_MANAGER, ROLES.ADMIN],
    ownerOnly: true,
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
//   - editor:        contenido editable SOLO en DRAFT/REJECTED Y solo si es
//                    el dueño (`createdBy`). Nunca puede tocar `isActive`
//                    (es una palanca de publicación, y el editor no publica).
//   - cualquier otro rol: sin campos editables.
const CONTENT_UNLOCKED_STATUSES = new Set([PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.REJECTED]);

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
  if (!Array.isArray(product.images) || product.images.length === 0) {
    errors.push("Debe cargar al menos una imagen.");
  }

  if (Array.isArray(product.variants) && product.variants.length > 0) {
    product.variants.forEach((v, i) => {
      if (!v.sku || !String(v.sku).trim()) errors.push(`La variante #${i + 1} necesita un SKU.`);
      if (!v.color || !String(v.color).trim()) errors.push(`La variante #${i + 1} necesita un color.`);
      if (v.stock === undefined || v.stock === null || Number(v.stock) < 0) {
        errors.push(`La variante #${i + 1} necesita un stock válido (≥ 0).`);
      }
    });
  } else if (product.stock === undefined || product.stock === null || Number(product.stock) < 0) {
    errors.push("El stock es obligatorio (≥ 0) para productos sin variantes.");
  }

  return errors;
}
