import { Router } from "express";
import {
  createProduct,
  deleteProductById,
  deleteProductImage,
  getProduct,
  getProductById,
  updateProductById,
  updateProductStatus,
  uploadProductImage,
} from "../controllers/product.controllers.js"
import autenticationUser, { optionalAuthentication } from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// FASE 3 — Product Domain + Editor Workflow.
// `editor` entra al CRUD de creacion/edicion (no podia antes: el CRUD era
// exclusivo de administrador/shop_manager). La autoridad de PUBLICAR sigue
// siendo exclusiva de administrador, exigida en el controller de transicion
// (`canTransitionProduct`), NUNCA solo aqui a nivel de rol de ruta.

// Crear un producto (nace SIEMPRE en DRAFT, ver controller)
router.post('/', autenticationUser, authorizationUser(['administrador', 'shop_manager', 'editor']), createProduct);

// Obtener todos los productos.
// Publica (sin token, o `?all` ausente/false): SOLO PUBLISHED + isActive.
// `optionalAuthentication` permite reconocer una sesion admin-capable sin
// exigirla — el controller decide que ve cada rol.
router.get('/', optionalAuthentication, getProduct);

// Obtener un producto por ID (misma logica: publica por defecto, ampliada
// solo si hay sesion admin-capable con acceso a ESE producto).
router.get('/:id', optionalAuthentication, getProductById);

// Actualizar CONTENIDO de un producto. Los campos realmente aceptados
// dependen del rol + estado + ownership (`editableFieldsFor` en el controller);
// esta lista de roles es solo el primer filtro grueso.
router.patch('/:id', autenticationUser, authorizationUser(['administrador', 'shop_manager', 'editor']), updateProductById);

// Transicion de estado del workflow editorial (DRAFT/PENDING_REVIEW/APPROVED/
// REJECTED/PUBLISHED). Unico endpoint para mover el ciclo de vida; la tabla
// de transiciones valida rol + ownership + estado origen->destino.
router.patch('/:id/status', autenticationUser, authorizationUser(['administrador', 'shop_manager', 'editor']), updateProductStatus);

// FASE 4 — Imagenes reales (Cloudinary, upload intermediado por backend).
// Mismo filtro de rol grueso que el resto del CRUD de contenido; la
// autorizacion REAL (ownership + estado editable) la aplica el controller
// via `editableFieldsFor` — identica regla que PATCH /:id, para que estas
// rutas no puedan usarse como atajo para saltarse ownership/estado.
router.post('/:id/images', autenticationUser, authorizationUser(['administrador', 'shop_manager', 'editor']), uploadProductImage);
router.delete('/:id/images/:imageId', autenticationUser, authorizationUser(['administrador', 'shop_manager', 'editor']), deleteProductImage);

// Eliminar un producto (se mantiene exclusivo de administrador/shop_manager;
// el editor no tiene autoridad para borrar, solo para crear/editar/enviar).
router.delete('/:id', autenticationUser, authorizationUser(['administrador', 'shop_manager']), deleteProductById)

export default router
