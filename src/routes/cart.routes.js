import { Router } from "express";

import {
    createCart,
    deleteCartById,
    getCartById,
    getCarts,
    updateCartById

} from "../controllers/cart.controller.js";

const router = Router();

router.post("/", createCart);

router.get("/", getCarts);

router.get("/:id", getCartById);

router.patch("/:id", updateCartById);

router.delete("/:id", deleteCartById);

export default router;