import { Router } from "express";
import { createProduct, deleteProductById, getProduct, getProductById, updateProductById } from "../controllers/product.controllers.js"
import autenticationUser from "../middleware/autentication.middleware.js";
import isAdmin from "../middleware/role.middleware.js";

const router = Router();

router.post('/', autenticationUser, isAdmin, createProduct);
router.get('/', autenticationUser, getProduct);
router.get('/:id', autenticationUser, getProductById);
router.patch('/:id',autenticationUser, isAdmin, updateProductById);
router.delete('/:id',autenticationUser, isAdmin,  deleteProductById)

export default router