import { Router } from "express";

const router = Router();

router.post('/', (req, res)=>{
    res.json({
        msg:"Se registra un usuario"
    });
});

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