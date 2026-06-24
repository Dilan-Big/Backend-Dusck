import { Router } from "express";
import { createUser, getUser, getUserById } from "../controllers/user.controller.js";

const router = Router();

router.post('/', createUser);

router.get('/',getUser);

router.get('/:id',getUserById);

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