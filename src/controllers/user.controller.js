import { dbCreateUser, dbGetUsers } from "../services/user.service.js";

const createUser = async (req, res) => {
    const inputData = req.body


    const data = await dbCreateUser(inputData)

    res.json({
        msg: "Se registra un usuario",
        data
    });
}

const getUser = async (req, res) => {
       
        const data = await dbGetUsers()
        res.json({
            msg: "Se obtiene el listado de usuarios",
            data
        });
    };

export { createUser, getUser };