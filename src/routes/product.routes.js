import { Router } from "express";
import { createProduct, getProduct } from "../controllers/product.controllers.js"

const router = Router();

router.post('/', createProduct);
router.get('/', getProduct)

export default router