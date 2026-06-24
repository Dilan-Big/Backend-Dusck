import { Router } from "express";
import { createUser } from "../controllers/user.controller.js";

const router = Router();

router.post('/', createUser);

router.get('/', (req, res)=>{
    res.json({
        msg:"Se obtiene el listado de usuarios"
    });
});

router.get('/:id',(req, res)=>{
    res.json({
        msg:"Se obtiene un usuario por id"
    });
});

router.patch('/:id', (req, res)=>{
    res.json({
        msg:"Se actualiza usuario por id"
    });
});

router.delete('/:id',(req, res)=>{
    res.json({
        msg:"Se elimina usuario por id"
    });
});

export default router;