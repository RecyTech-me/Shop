const { spawnSync } = require("child_process");

const DEFAULT_THRESHOLDS = {
    line: 75,
    branch: 55,
    funcs: 75,
};

function readThreshold(name, fallback) {
    const parsed = Number.parseFloat(process.env[name] || "");
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stripAnsi(value) {
    return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

function parseCoverage(output) {
    const cleanOutput = stripAnsi(output);
    const match = cleanOutput.match(/all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/i);
    if (!match) {
        throw new Error("Could not find all-file coverage summary in test output.");
    }

    return {
        line: Number.parseFloat(match[1]),
        branch: Number.parseFloat(match[2]),
        funcs: Number.parseFloat(match[3]),
    };
}

function main() {
    const thresholds = {
        line: readThreshold("COVERAGE_LINE_MIN", DEFAULT_THRESHOLDS.line),
        branch: readThreshold("COVERAGE_BRANCH_MIN", DEFAULT_THRESHOLDS.branch),
        funcs: readThreshold("COVERAGE_FUNCS_MIN", DEFAULT_THRESHOLDS.funcs),
    };
    const result = spawnSync(process.execPath, ["--test", "--experimental-test-coverage"], {
        encoding: "utf8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;

    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");

    if (result.status !== 0) {
        process.exitCode = result.status;
        return;
    }

    const coverage = parseCoverage(output);
    const failures = Object.entries(thresholds)
        .filter(([key, threshold]) => coverage[key] < threshold)
        .map(([key, threshold]) => `${key} ${coverage[key].toFixed(2)}% < ${threshold.toFixed(2)}%`);

    if (failures.length) {
        console.error(`Coverage threshold failed: ${failures.join(", ")}`);
        process.exitCode = 1;
        return;
    }

    console.log(`Coverage thresholds passed: line ${coverage.line.toFixed(2)}%, branch ${coverage.branch.toFixed(2)}%, funcs ${coverage.funcs.toFixed(2)}%.`);
}

if (require.main === module) {
    main();
}

module.exports = {
    parseCoverage,
    readThreshold,
};
