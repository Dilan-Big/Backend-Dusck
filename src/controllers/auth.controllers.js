
import { verificatePassword } from "../helpers/bycryp.helper.js";
import { dbGetUserByIdEmail } from "../services/user.service.js";
import { generarToken } from "../helpers/jwt.helpers.js";

const loginUser =  async (req, res) => {

    const inputData = req.body
    const userFound = await dbGetUserByIdEmail(inputData.email);

    if ( ! userFound) {
        return  res.status(400).json({
            msg:"Usuario no encontrado por favor registrese"
        });
    }

    const isValePassword = verificatePassword(inputData.password, userFound.password)

    if ( ! isValePassword ) {
        return res.status(400).json({
            msg: "SU contraseña no es valida"
        });
    }

    const payload = {
        _id: userFound._id,
        name: userFound.name,
        email: userFound.email,
        nickname: userFound.nickname,
        role: userFound.role
    }

    const token = generarToken(payload)
    if( ! token) {
        return res.status(400).json({
            msg: "No se puede generar token",
            token
        })
    }

    const userData = userFound.toObject()

    delete userData.password

    delete userData.createdAt

    delete userData.updatedAt

    res.json({
        msg: "Se genera logeo",
        token,
        data: userData
    });
}


const renewToken = (req, res) => {
    const payload = req.payload
    const userFound = req.user

    const newPayload = {
          _id: userFound._id,
          name: userFound.name,
          email: userFound.email,
          nickname: userFound.nickname,
          role: userFound.role,
    };

    const token = generarToken(newPayload)
   
    // const userData = userFound.toObject()

    // delete userData.password

    // delete userData.createdAt

    // delete userData.updatedAt


    res.json({
        msg: "Renovar Token",
        token,
        data: userFound
    });
}

export{
    loginUser,
    renewToken
}