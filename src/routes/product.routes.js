import { Router } from "express";
import { createProduct, getProduct, getProductById, updateProductById } from "../controllers/product.controllers.js"

const router = Router();

router.post('/', createProduct);
router.get('/', getProduct);
router.get('/:id', getProductById);
router.patch('/:id', updateProductById)

export default router