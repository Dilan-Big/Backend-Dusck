import { ALLOWED_ROLES, ROLES_LABELS } from "../config/global.config.js"

const dbGetRoles = () => {
    return ALLOWED_ROLES.map( (role) => {
        return {
            id: role,
            name: ROLES_LABELS[ role ]
        }
    } );
} 

export default dbGetRoles;