import { Router } from "express";
import {
    deleteMyCart,
    getMyCart,
    removeMyCartItem,
    updateMyCart
} from "../controllers/cart.controller.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";
import autenticationUser from "../middleware/autentication.middleware.js";

const router = Router();

// Esta Ruta intenta obtener el carrito que no existe y lo crea
router.get(
    "/", 
    [autenticationUser, authorizationUser(['subscriber'])], 
    getMyCart
);

router.patch("/",
    [autenticationUser, authorizationUser(['subscriber'])], 
    updateMyCart
)

router.delete(
    "/items/:productId",
    [autenticationUser,authorizationUser(['subscriber'])],
    removeMyCartItem
)

router.delete(
    "/",
    [autenticationUser, authorizationUser(['subscriber'])],
    deleteMyCart
)



export default router;