import { Router  } from "express";
import { createCategory, getCategory, getCategoryById, updateCategoryById } from "../controllers/category.controllers.js";

const router = Router();

router.post('/', createCategory);
router.get('/', getCategory);
router.get('/:id',getCategoryById);
router.patch('/:id', updateCategoryById);

export default router;