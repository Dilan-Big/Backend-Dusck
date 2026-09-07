import { Router  } from "express";
import { createCategory, deleteCategoryById, getCategory, getCategoryById, updateCategoryById } from "../controllers/category.controllers.js";
import autenticationUser, { optionalAuthentication } from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// Crear categoría
router.post('/', autenticationUser,  authorizationUser(['administrador', 'shop_manager']), createCategory);

// F7-C / F7-CLOSURE — `optionalAuthentication` (no `autenticationUser`):
// sigue siendo alcanzable SIN sesión (igual que antes), pero si llega un
// token válido puebla `req.user`. El controller sirve el contrato completo
// (incluye inactivas) SOLO si se cumplen a la vez `?all=true` explícito Y rol
// admin-capable; en cualquier otro caso responde el contrato público (solo
// `isActive:true`). Mismo patrón exacto que `product.routes.js` / `getProduct`.
// Obtener todas las categorías
router.get('/', optionalAuthentication, getCategory);

// Obtener una categoría por ID
router.get('/:id', optionalAuthentication, getCategoryById);

// Actualizar una categoría
router.patch('/:id',autenticationUser, authorizationUser(['administrador', 'shop_manager']), updateCategoryById);

// Eliminar una categoría
router.delete('/:id',autenticationUser,  authorizationUser(['administrador', 'shop_manager']), deleteCategoryById);

export default router;