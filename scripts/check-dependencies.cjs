// Check the app's resolution, without treating sibling workspace leftovers as
// failures. Runs with plain Node so it also diagnoses broken TS runners.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const semver = require('semver');

const root = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(root, 'package.json'));
const manifest = appRequire('./package.json');
let failed = false;
for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    try {
        let packageFile;
        try {
            packageFile = appRequire.resolve(`${name}/package.json`);
        } catch (error) {
            if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
            // Packages may hide package.json behind an exports map.
            let directory = path.dirname(appRequire.resolve(name));
            while (directory !== path.dirname(directory)) {
                const candidate = path.join(directory, 'package.json');
                if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) {
                    packageFile = candidate;
                    break;
                }
                directory = path.dirname(directory);
            }
            if (!packageFile) throw new Error('Cannot locate package metadata');
        }
        const { version } = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        const valid = semver.satisfies(version, range);
        console.log(`${valid ? 'OK' : 'INVALID'} ${name}@${version} (requires ${range}) — ${packageFile}`);
        if (!valid) failed = true;
    } catch (error) {
        console.error(`MISSING ${name}: ${error.message}`);
        failed = true;
    }
}
if (failed) {
    console.error('Dependency preflight failed. Reinstall from the owning workspace root or use npm ci in a standalone checkout.');
    process.exitCode = 1;
}
