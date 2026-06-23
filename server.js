require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const { app } = require("./app");

const env = process.env;
const port = Number.parseInt(env.PORT || "3000", 10);
const host = env.HOST || "127.0.0.1";

if (require.main === module) {
    app.listen(port, host, () => {
        console.log(`RecyTech shop listening on http://${host}:${port}`);
    });
}

module.exports = { app };
