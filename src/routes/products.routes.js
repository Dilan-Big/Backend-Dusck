import { Router } from "express";

import {
    createProduct,
    deleteProductById,
    getProducts,
    getProductById,
    updateProductById
} from "../controllers/products.controllers.js";

const router = Router();

// Crear un producto
router.post("/", createProduct);

// Obtener todos los productos
router.get("/", getProducts);

// Obtener un producto por ID
router.get("/:id", getProductById);

// Actualizar un producto por ID
router.patch("/:id", updateProductById);

// Eliminar un producto por ID
router.delete("/:id", deleteProductById);

export default router;