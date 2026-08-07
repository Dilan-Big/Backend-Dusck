import { Router  } from "express";
import { createCategory, deleteCategoryById, getCategory, getCategoryById, updateCategoryById } from "../controllers/category.controllers.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// Crear categoría
router.post('/', autenticationUser,  authorizationUser(['administrador', 'shop_manager']), createCategory);

// Obtener todas las categorías
router.get('/', getCategory);

// Obtener una categoría por ID
router.get('/:id',getCategoryById);

// Actualizar una categoría
router.patch('/:id',autenticationUser, authorizationUser(['administrador', 'shop_manager']), updateCategoryById);

// Eliminar una categoría
router.delete('/:id',autenticationUser,  authorizationUser(['administrador', 'shop_manager']), deleteCategoryById);

export default router;