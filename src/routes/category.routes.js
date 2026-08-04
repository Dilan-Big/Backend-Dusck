import { Router  } from "express";
import { createCategory, deleteCategoryById, getCategory, getCategoryById, updateCategoryById } from "../controllers/category.controllers.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import { isAdmin } from "../middleware/role.middleware.js";

const router = Router();

router.post('/', autenticationUser, isAdmin, createCategory);
router.get('/', getCategory);
router.get('/:id',getCategoryById);
router.patch('/:id',autenticationUser, isAdmin, updateCategoryById);
router.delete('/:id',autenticationUser, isAdmin, deleteCategoryById);

export default router;