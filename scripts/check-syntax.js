const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ejs = require("ejs");

const rootDir = path.resolve(__dirname, "..");

function walkFiles(directory, predicate, results = []) {
    if (!fs.existsSync(directory)) {
        return results;
    }

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, predicate, results);
        } else if (predicate(fullPath)) {
            results.push(fullPath);
        }
    }

    return results;
}

function relative(filePath) {
    return path.relative(rootDir, filePath);
}

function checkNodeFile(filePath) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
        cwd: rootDir,
        encoding: "utf8",
    });

    if (result.status !== 0) {
        throw new Error(`${relative(filePath)}\n${result.stderr || result.stdout}`);
    }
}

function checkBrowserModule(filePath) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        cwd: rootDir,
        input: fs.readFileSync(filePath, "utf8"),
        encoding: "utf8",
    });

    if (result.status !== 0) {
        throw new Error(`${relative(filePath)}\n${result.stderr || result.stdout}`);
    }
}

function checkEjsTemplate(filePath) {
    ejs.compile(fs.readFileSync(filePath, "utf8"), {
        filename: filePath,
    });
}

const nodeFiles = [
    path.join(rootDir, "app.js"),
    path.join(rootDir, "server.js"),
    ...walkFiles(path.join(rootDir, "lib"), (filePath) => filePath.endsWith(".js")),
    ...walkFiles(path.join(rootDir, "routes"), (filePath) => filePath.endsWith(".js")),
    ...walkFiles(path.join(rootDir, "scripts"), (filePath) =>
        filePath.endsWith(".js") && path.basename(filePath) !== "check-syntax.js"
    ),
];
const browserModules = walkFiles(path.join(rootDir, "public", "scripts"), (filePath) => filePath.endsWith(".js"));
const templates = walkFiles(path.join(rootDir, "views"), (filePath) => filePath.endsWith(".ejs"));

for (const filePath of nodeFiles) {
    checkNodeFile(filePath);
}

for (const filePath of browserModules) {
    checkBrowserModule(filePath);
}

for (const filePath of templates) {
    checkEjsTemplate(filePath);
}

console.log(`Checked ${nodeFiles.length} Node files, ${browserModules.length} browser modules, and ${templates.length} EJS templates.`);
