import { Router  } from "express";
import { createCategory, getCategory, getCategoryById } from "../controllers/category.controllers.js";

const router = Router();

router.post('/', createCategory);
router.get('/', getCategory);
router.get('/',getCategoryById);

export default router;