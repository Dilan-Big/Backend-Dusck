import { Router } from "express";
import { createProduct, deleteProductById, getProduct, getProductById, updateProductById } from "../controllers/product.controllers.js"

const router = Router();

router.post('/', createProduct);
router.get('/', getProduct);
router.get('/:id', getProductById);
router.patch('/:id', updateProductById);
router.delete('/:id', deleteProductById)

export default router