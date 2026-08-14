import { Router } from "express";
import {
    deleteCart,
    deleteMyCart,
    getCart,
    getCartById,
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

// Herramientas administrativas: solo un ADMIN puede listar u operar sobre
// el carrito de cualquier usuario a partir de su _id de Mongo.
router.get(
    "/admin",
    [autenticationUser, authorizationUser(['administrador'])],
    getCart
)

router.get(
    "/admin/:id",
    [autenticationUser, authorizationUser(['administrador'])],
    getCartById
)

router.delete(
    "/admin/:id",
    [autenticationUser, authorizationUser(['administrador'])],
    deleteCart
)



export default router;