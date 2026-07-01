import { verificatePassword } from "../helpers/bcrypt.helpers.js";
import { generateToken } from "../helpers/jwt.helpers.js";
import { dbGetUserByEmail } from "../services/user.service.js";

const loginUser = async (req, res) => {

    const inputData = req.body;
    const userFound = await dbGetUserByEmail(inputData.email);

    if (! userFound){
        return res.status(400).json({
            msg:"Usuario no encontrado porfavor registrarse"
        })
    }

    const isValePassword = verificatePassword (inputData.password, userFound.password)

        if (! isValePassword) {
            return res.status(400).json({
                msg:"Contraseña no es valida"
            })
        }

        const payload = {
            _id: userFound._id,
            name: userFound.name,
            email: userFound.email,
            nickname: userFound.nickname,
            role: userFound.role
        }

       const token = generateToken (payload)

       if (!token) {
        return res.status(400).json({
            msg:"No se pudo generar Token"
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
};

const renewToken = (req, res) => {
    const payload= req.payload
    const userFound = req.user
    res.json({
        msg: "Renovar Token",payload, userFound
    });
}

export {loginUser, renewToken};