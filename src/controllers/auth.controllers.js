

import { verificatePassword } from "../helpers/bycryp.helper.js";
import { dbGetUserByIdEmail } from "../services/user.service.js";
import { generateToken } from "../helpers/jwt.helpers.js";
import { isPlainString } from "../helpers/validation.helpers.js";

const loginUser =  async (req, res) => {

  try {
    const { email, password } = req.body;

    // FASE 2 / S4: email y password son conceptualmente strings. Se comprueba
    // el TIPO real antes de construir la consulta. Un objeto como
    // { "$ne": null } o { "$gt": "" } nunca llega a findOne({ email }).
    // No se hace String(email): eso ocultaria el input malicioso.
    if ( ! isPlainString(email) || ! isPlainString(password) ) {
        return res.status(400).json({
            msg: "Credenciales inválidas"
        });
    }

    // Normalizacion segura, solo despues de validar el tipo. El modelo guarda
    // el email en minusculas y sin espacios.
    const normalizedEmail = email.trim().toLowerCase();

    const userFound = await dbGetUserByIdEmail(normalizedEmail);

    if ( ! userFound) {
        return  res.status(400).json({
            msg:"Usuario no encontrado por favor registrese"
        });
    }

    const isValePassword = verificatePassword(password, userFound.password)

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

    const token = generateToken(payload)
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

  } catch (error) {
    // Mensaje generico; sin detalles internos de Mongo ni del error (REGLA 16).
    console.error(`Error en login -> ${error.name}`);
    return res.status(500).json({
        msg: "No se pudo procesar el inicio de sesión"
    });
  }

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

    const token = generateToken(newPayload)
   
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

