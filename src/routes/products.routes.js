import { Router } from "express";

import {
    createProduct,
    deleteProductById,
    getProducts,
    getProductById,
    updateProductById
} from "../controllers/products.controllers.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// Crear un producto
router.post("/", 
    [ autenticationUser, authorizationUser(['administrador'])],
    createProduct);

// Obtener todos los productos
router.get("/", getProducts);

// Obtener un producto por ID
router.get("/:id", getProductById);

// Actualizar un producto por ID
router.patch("/:id", [autenticationUser, authorizationUser(['administrador', 'editor'])], updateProductById);

// Eliminar un producto por ID
router.delete("/:id",[autenticationUser, authorizationUser(['administrador', 'editor'])], deleteProductById);

export default router;