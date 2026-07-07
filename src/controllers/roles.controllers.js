import dbGetRoles from "../services/role.servises.js";

    const getRoles = (req, res) => {

        const roles = dbGetRoles();

    res.json({
        msg:"Obtien todos los roles definidos para la aplicacion",
        data: roles
    });
};
export default getRoles;