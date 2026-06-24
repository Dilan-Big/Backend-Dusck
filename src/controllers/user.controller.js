import { dbCreateUser } from "../services/user.service.js";

const createUser = async (req, res)=>{
    const inputData = req.body


   const data = await dbCreateUser(inputData)

    res.json({
        msg:"Se registra un usuario",
        data:data 
    });
}

export {createUser};