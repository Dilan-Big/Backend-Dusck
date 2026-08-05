import { Schema, model } from "mongoose";

const VariantSchema = new Schema({
    size: {
        type: String,
        required: [true, 'La talla es obligatoria'],
        enum: ['XS', 'S', 'M', 'L', 'XL', 'XXL']
    },

    color: {
        type: String,
        required: [true, 'El color es obligatorio'],
        trim: true,
        maxlength: [30, 'El color no puede superar los 30 caracteres']
    },

    stock: {
        type: Number,
        required: true,
        default: 0,
        min: [0, 'El stock no puede ser negativo']
    }

}, {
    _id: false
});

const ProductSchema = new Schema({

    name: {
        type: String,
        required: [true, 'El nombre del producto es obligatorio'],
        trim: true,
        minlength: [3, 'El nombre debe tener mínimo 3 caracteres'],
        maxlength: [120, 'El nombre no puede superar los 120 caracteres']
    },

    slug: {
        type: String,
        required: [true, 'El slug es obligatorio'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[a-z0-9-]+$/, 'El slug solo puede contener letras minúsculas, números y guiones']
    },

    description: {
        type: String,
        required: [true, 'La descripción es obligatoria'],
        trim: true,
        minlength: [20, 'La descripción debe tener al menos 20 caracteres'],
        maxlength: [3000, 'La descripción no puede superar los 3000 caracteres']
    },

    brand: {
        type: String,
        required: [true, 'La marca es obligatoria'],
        trim: true,
        maxlength: [50, 'La marca no puede superar los 50 caracteres']
    },

    // subcategory: {
    //     type: String,
    //     trim: true,
    //     default: ''
    // },

    gender: {
        type: String,
        required: true,
        enum: [
            'hombre',
            'mujer',
            'unisex',
            'niño',
            'niña'
        ],
        default: 'unisex'
    },

    price: {
        type: Number,
        required: [true, 'El precio es obligatorio'],
        min: [0, 'El precio no puede ser negativo']
    },

    discountPrice: {
        type: Number,
        default: 0,
        min: [0, 'El precio con descuento no puede ser negativo'],
        validate: {
            validator: function(value) {
                return value <= this.price;
            },
            message: 'El precio con descuento no puede ser mayor al precio original'
        }
    },

    images: [{
        type: String,
        trim: true
    }],

    variants: {
        type: [VariantSchema],
        required: [true, 'Debe existir al menos una variante'],
        validate: {
            validator: function(value) {
                return value.length > 0;
            },
            message: 'El producto debe tener al menos una variante'
        }
    },

    tags: [{
        type: String,
        lowercase: true,
        trim: true
    }],

    featured: {
        type: Boolean,
        default: false
    },

    status: {
        type: Boolean,
        default: true
    },

    createdUserId: {
        type: Schema.Types.ObjectId,
        ref: 'user',
        required: [true, 'El usuario creador es obligatorio']
    }

}, {
    versionKey: false,
    timestamps: true
});

const ProductModel = model(
    'product',
    ProductSchema
);

export default ProductModel;