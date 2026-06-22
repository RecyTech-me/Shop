const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: [
            "node_modules/**",
            "storage/**",
            "public/uploads/**",
        ],
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": ["warn", {
                argsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
            }],
            "no-useless-assignment": "off",
            "no-useless-escape": "off",
        },
    },
    {
        files: ["public/scripts/**/*.js"],
        languageOptions: {
            sourceType: "module",
            globals: {
                ...globals.browser,
            },
        },
    },
    {
        files: ["test/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
];
