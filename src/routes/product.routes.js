import { Router } from "express";
import { createProduct, deleteProductById, getProduct, getProductById, updateProductById } from "../controllers/product.controllers.js"
import autenticationUser from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// Crear un producto
router.post('/', autenticationUser, authorizationUser(['administrador', 'shop_manager']), createProduct);

// Obtener todos los productos
router.get('/', getProduct);

// Obtener un producto por ID
router.get('/:id', getProductById);

// Actualizar un producto
router.patch('/:id', autenticationUser, authorizationUser(['administrador', 'shop_manager']), updateProductById);

// Eliminar un producto
router.delete('/:id',autenticationUser, authorizationUser(['administrador', 'shop_manager']),  deleteProductById)

export default router