import { validadeToken } from "../helpers/jwt.helpers.js"
import { dbGetUserById } from "../services/user.service.js"

const authenticationUser = async (req, res, next) => {

    const token = req.header('x-token')

    if (! token) {
        return res.status(401).json({
            msg:"Cadena de token vacia"
        })
    }

    const payload = validadeToken(token)

    if (!payload) {
        return res.status(401).json({
            msg:'Token no valido (expirado)'
        })
    }

    delete payload.exp
    delete payload.iat

    const userFound = await dbGetUserById(payload._id)

    if (!userFound) {
        return res.status(401).json({
            msg:"Token no valido, no exite usuario"
        })
    }

    if (!userFound.status){
        return res.status(401).json({
            msg:"No se encuentraactivo el usuario"
        })
    }

    const userData = userFound.toObject()

    delete userData.password

    delete userData.createdAt

    delete userData.updatedAt

    console.log("Soy el midleware de autenticacion", payload)

    req.payload = payload

    req.user = userData

    next ()
}

export default authenticationUser