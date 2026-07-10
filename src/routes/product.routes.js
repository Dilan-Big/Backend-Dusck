import { Router } from "express";
import { createProduct, getProduct, getProductById } from "../controllers/product.controllers.js"

const router = Router();

router.post('/', createProduct);
router.get('/', getProduct);
router.get('/:id', getProductById);

export default router