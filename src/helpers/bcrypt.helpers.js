import bcrypt from "bcrypt";

const encryptedPasword = (originalPasword) => {
    const salt = bcrypt.genSaltSync (5)
        return bcrypt.hashSync (originalPasword, salt);
};

const verificatePassword = (originalPasword, hashPassword) => {
    return bcrypt.compareSync(originalPasword, hashPassword);
}

export {encryptedPasword, verificatePassword};