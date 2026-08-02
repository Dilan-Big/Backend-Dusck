import bcrypt from "bcrypt"

const encryptedPassword = (originalPassword) => {
    const salt = bcrypt.genSaltSync (5)
    return bcrypt.hashSync (originalPassword, salt)
}

const verificatePassword = (originalPassword, hashPassword) => {
    return bcrypt.compareSync(originalPassword, hashPassword)
}

export {
    encryptedPassword,
    verificatePassword
}