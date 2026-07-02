import { validateToken } from "../helpers/jwt.helpers.js";
import { dbGetUserById } from "../services/user.service.js";

const autenticationUser = async (req, res, next) => {

    const token = req.header("x-token")

    if (! token) {
        return res.status(401).json({
            msg: "cadena del token vacia"
        });
    }

    const payload = validateToken(token)

    if (! payload) {
        return res.status(401).json({
            msg: "Token no valido fue expirado"
        })
    }

    delete payload.exp
    delete payload.iat
    

    const userFound = await dbGetUserById(payload._id)
    
    if (! userFound) {
        return res.status(401).json({
            msg: "Token no valido, no existe el usuario "
        })
    }

    if (! userFound.status) {
        return res.status(401).json({
            msg: "No se encuentra activo el usuario"
        })
    }

    const userData = userFound.toObject()

    delete userData.password

    delete userData.createdAt

    delete userData.updatedAt

    console.log("soy el midelware de autenticacion", payload)

    req.payload = payload

    req.user = userData


    next() 
}

export default autenticationUser