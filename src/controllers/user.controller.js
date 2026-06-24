import { dbCreateUser, dbGetUsers } from "../services/user.service.js";

const createUser = async (req, res) => {

    try {
        const inputData = req.body


        const data = await dbCreateUser(inputData)

        res.json({
            msg: "Se registra un usuario",
            data
        });
    } catch (error) {
        res.json({
            msg: "Ocurrio un error al obtener el usuario"
        })
    }


}

const getUser = async (req, res) => {
    try {
        const data = await dbGetUsers()
        res.json({
            msg: "Se obtiene el listado de usuarios",
            data
        });
    } catch (error) {
        console.error(error)
        res.json({
            msg: "Ocurrio un error a obtener la lista de usuarios"
        })
    }

};

export { createUser, getUser };